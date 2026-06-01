/**
 * web/lib/tradeLogs.ts
 *
 * Server-only helper for writing per-user trade events into the Supabase
 * `trade_logs` table.
 *
 * Contract:
 *   - Never throw in a way that would break a live trade. The caller wraps
 *     in try/catch already, but additionally every write is double-guarded
 *     so a Supabase outage degrades to a warning log, never an upstream 500.
 *   - Always include the Clerk user_id; the table FKs to public.users
 *     (deny-all RLS otherwise).
 *   - Strip apiKey / token / secret / encrypted_* keys from raw_payload
 *     before insert. Sanitisation is recursive (deep walk) so nested broker
 *     responses can't leak credentials.
 */

import 'server-only';
import { getServerSupabase } from './db';
import { sanitizePayload as sanitizePayloadJs } from './sanitizePayload.js';

export type TradeEventType =
  | 'opened'
  | 'closed'
  | 'partial_closed'
  | 'tp_updated'
  | 'sl_updated'
  | 'reassessed'
  | 'auto_close_recommended'
  | 'manual_close_executed'
  | 'error';

export type TradeLogInput = {
  userId: string;
  organizationId?: string | null;
  broker: 'oanda' | 'alpaca';
  brokerAccountId?: string | null;
  environment: 'practice' | 'live' | 'paper';
  eventType: TradeEventType;
  instrument?: string | null;
  tradeId?: string | null;
  brokerOrderId?: string | null;
  side?: 'long' | 'short' | null;
  units?: number | null;
  unitsClosed?: number | null;
  entryPrice?: number | null;
  exitPrice?: number | null;
  realizedPL?: number | null;
  unrealizedPL?: number | null;
  tp?: number | null;
  sl?: number | null;
  recommendation?: string | null;
  confidence?: number | null;
  reason?: string | null;
  rawPayload?: unknown;
  // Signal Stack V3 — Edge Intelligence snapshot (all optional / nullable).
  // Purely additive: capture the conditions a trade was taken under so the
  // Edge Intelligence dashboard can attribute performance. Never affects how a
  // trade is placed, sized, or closed.
  edge?: EdgeSnapshotInput | null;
};

export type EdgeSnapshotInput = {
  pair?: string | null;
  direction?: 'long' | 'short' | null;
  entryTime?: string | null;   // ISO timestamptz
  exitTime?: string | null;    // ISO timestamptz
  pnl?: number | null;
  winLoss?: 'win' | 'loss' | 'breakeven' | null;
  session?: string | null;
  spread?: number | null;
  signalScore?: number | null;
  trend?: string | null;
  volatility?: string | null;
  marketRegime?: string | null;
  macroBias?: string | null;
  macroRisk?: string | null;
};

export type TradeLogResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/**
 * Recursive deep-redact. Delegates to `./sanitizePayload.js` so the JS
 * algorithm can be unit-tested with `node --test` without TS tooling and
 * still be the single source of truth used in production.
 */
export const sanitizePayload = sanitizePayloadJs as (input: unknown) => unknown;

function normalizeInstrument(instrument?: string | null): string | null {
  if (!instrument) return null;
  return String(instrument).replace('/', '_').toUpperCase();
}

function numeric(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Map an optional EdgeSnapshotInput onto its DB columns. Returns an empty
 * object when no snapshot is provided, so the insert row is byte-identical to
 * the pre-V3 behaviour for callers that don't pass `edge`.
 */
function edgeColumns(edge?: EdgeSnapshotInput | null): Record<string, unknown> {
  if (!edge) return {};
  return {
    pair:          edge.pair ? normalizeInstrument(edge.pair) : null,
    direction:     edge.direction ?? null,
    entry_time:    edge.entryTime ?? null,
    exit_time:     edge.exitTime ?? null,
    pnl:           numeric(edge.pnl),
    win_loss:      edge.winLoss ?? null,
    session:       edge.session ?? null,
    spread:        numeric(edge.spread),
    signal_score:  numeric(edge.signalScore),
    trend:         edge.trend ?? null,
    volatility:    edge.volatility ?? null,
    market_regime: edge.marketRegime ?? null,
    macro_bias:    edge.macroBias ?? null,
    macro_risk:    edge.macroRisk ?? null,
  };
}

/**
 * Insert one trade event. Never throws to the caller — failures degrade to
 * a console warning and a structured `{ ok: false, error }` so the upstream
 * execution path is not impacted by logging issues.
 */
export async function logTradeEvent(input: TradeLogInput): Promise<TradeLogResult> {
  try {
    if (!input.userId) {
      console.warn('[TRADE_LOG] skipped — missing userId');
      return { ok: false, error: 'Missing userId' };
    }
    const supabase = getServerSupabase();
    const row = {
      user_id:           input.userId,
      organization_id:   input.organizationId ?? null,
      broker:            input.broker,
      broker_account_id: input.brokerAccountId ?? null,
      environment:       input.environment,
      instrument:        normalizeInstrument(input.instrument),
      trade_id:          input.tradeId ?? null,
      broker_order_id:   input.brokerOrderId ?? null,
      event_type:        input.eventType,
      side:              input.side ?? null,
      units:             numeric(input.units),
      units_closed:      numeric(input.unitsClosed),
      entry_price:       numeric(input.entryPrice),
      exit_price:        numeric(input.exitPrice),
      realized_pl:       numeric(input.realizedPL),
      unrealized_pl:     numeric(input.unrealizedPL),
      tp:                numeric(input.tp),
      sl:                numeric(input.sl),
      recommendation:    input.recommendation ?? null,
      confidence:        numeric(input.confidence),
      reason:            input.reason ?? null,
      raw_payload:       input.rawPayload == null ? null : (sanitizePayload(input.rawPayload) as Record<string, unknown>),
      // Edge Intelligence snapshot columns (added 20260531120000). All nullable;
      // omitted entirely when no edge data is supplied so existing writers and
      // rows are unaffected.
      ...edgeColumns(input.edge),
    };
    const { data, error } = await supabase
      .from('trade_logs')
      .insert(row)
      .select('id')
      .single();
    if (error || !data) {
      console.warn(
        `[TRADE_LOG] insert failed user=${input.userId} event=${input.eventType}: ${error?.message ?? 'no row'}`,
      );
      return { ok: false, error: error?.message ?? 'no row returned' };
    }
    return { ok: true, id: String(data.id) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[TRADE_LOG] exception user=${input.userId} event=${input.eventType}: ${message}`);
    return { ok: false, error: message };
  }
}

export type TradeLogFilters = {
  instrument?: string;
  eventType?: TradeEventType;
  tradeId?: string;
  startDate?: string;   // ISO timestamptz
  endDate?: string;     // ISO timestamptz
  limit?: number;       // 1..200
  cursor?: string;      // ISO timestamptz of the oldest row already returned
};

export type TradeLogRow = {
  id: string;
  created_at: string;
  user_id: string;
  organization_id: string | null;
  broker: string;
  broker_account_id: string | null;
  environment: string;
  event_type: TradeEventType;
  instrument: string | null;
  trade_id: string | null;
  broker_order_id: string | null;
  side: 'long' | 'short' | null;
  units: number | null;
  units_closed: number | null;
  entry_price: number | null;
  exit_price: number | null;
  realized_pl: number | null;
  unrealized_pl: number | null;
  tp: number | null;
  sl: number | null;
  recommendation: string | null;
  confidence: number | null;
  reason: string | null;
  raw_payload: unknown;
  // Edge Intelligence snapshot columns (nullable; added 20260531120000).
  pair: string | null;
  direction: 'long' | 'short' | null;
  entry_time: string | null;
  exit_time: string | null;
  pnl: number | null;
  win_loss: string | null;
  session: string | null;
  spread: number | null;
  signal_score: number | null;
  trend: string | null;
  volatility: string | null;
  market_regime: string | null;
  macro_bias: string | null;
  macro_risk: string | null;
};

/**
 * Read the current user's trade logs. Always filters by user_id so a future
 * mistake (or a service-role query without an explicit user_id) can't return
 * another user's records.
 */
export async function listTradeLogsForUser(
  clerkUserId: string,
  filters: TradeLogFilters = {},
): Promise<{ rows: TradeLogRow[]; nextCursor: string | null }> {
  if (!clerkUserId) throw new Error('listTradeLogsForUser: missing clerkUserId');
  const supabase = getServerSupabase();
  const limit = Math.max(1, Math.min(200, filters.limit ?? 50));
  let q = supabase
    .from('trade_logs')
    .select(
      'id, created_at, user_id, organization_id, broker, broker_account_id, environment, ' +
        'event_type, instrument, trade_id, broker_order_id, side, units, units_closed, ' +
        'entry_price, exit_price, realized_pl, unrealized_pl, tp, sl, recommendation, ' +
        'confidence, reason, raw_payload, ' +
        'pair, direction, entry_time, exit_time, pnl, win_loss, session, spread, ' +
        'signal_score, trend, volatility, market_regime, macro_bias, macro_risk',
    )
    .eq('user_id', clerkUserId);
  if (filters.instrument) q = q.eq('instrument', normalizeInstrument(filters.instrument));
  if (filters.eventType)  q = q.eq('event_type', filters.eventType);
  if (filters.tradeId)    q = q.eq('trade_id',   filters.tradeId);
  if (filters.startDate)  q = q.gte('created_at', filters.startDate);
  if (filters.endDate)    q = q.lte('created_at', filters.endDate);
  if (filters.cursor)     q = q.lt('created_at',  filters.cursor);
  q = q.order('created_at', { ascending: false }).limit(limit + 1);
  const { data, error } = await q;
  if (error) throw new Error(`listTradeLogsForUser: ${error.message}`);
  const all = (data ?? []) as unknown as TradeLogRow[];
  const rows = all.slice(0, limit);
  const nextCursor = all.length > limit ? rows[rows.length - 1]?.created_at ?? null : null;
  return { rows, nextCursor };
}
