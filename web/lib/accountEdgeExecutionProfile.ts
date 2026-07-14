import 'server-only';

import { getServerSupabase } from './db';
import { generateAttributionReport } from './edgeAnalytics';
import type { TradeLogRow, TradeEventType } from './tradeLogs';
import {
  buildEdgeExecutionProfile,
  extractBrokerAccountId,
} from './edgeExecutionProfile.js';

type CompactRow = Record<string, unknown>;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stringOrNull(value: unknown): string | null {
  const valueString = String(value ?? '').trim();
  return valueString ? valueString : null;
}

function eventType(row: CompactRow): TradeEventType {
  const raw = String(row.event_type ?? row.status ?? '').toLowerCase();
  if (raw === 'opened' || raw === 'open') return 'opened';
  if (raw === 'closed' || raw === 'close') return 'closed';
  if (raw === 'partial_closed' || raw === 'partial') return 'partial_closed';
  if (raw === 'manual_close_executed') return 'manual_close_executed';
  if (raw === 'error') return 'error';
  return 'reassessed';
}

function tradeIdFromRow(row: CompactRow): string | null {
  const payload = object(row.payload);
  const raw = object(row.raw_payload);
  const executed = object(raw.executed);
  const transaction = object(raw.transaction);

  return stringOrNull(
    row.trade_id ??
    payload.trade_id ??
    payload.broker_order_id ??
    raw.tradeId ??
    executed.tradeId ??
    transaction.tradeID ??
    null,
  );
}

function edgeObject(row: CompactRow): Record<string, unknown> {
  const payload = object(row.payload);
  const raw = object(row.raw_payload);
  return object(raw.edge ?? payload.edge);
}

function mapCompactRow(row: CompactRow): TradeLogRow {
  const edge = edgeObject(row);
  const pair = stringOrNull(row.pair ?? edge.pair);
  const direction = stringOrNull(row.direction ?? edge.direction);
  const createdAt = String(row.created_at ?? '');
  const type = eventType(row);

  return {
    id: String(row.id ?? ''),
    created_at: createdAt,
    user_id: String(row.user_id ?? ''),
    organization_id: null,
    broker: 'oanda',
    broker_account_id: extractBrokerAccountId(row),
    environment: '',
    event_type: type,
    instrument: pair,
    trade_id: tradeIdFromRow(row),
    broker_order_id: null,
    side: direction === 'long' || direction === 'short' ? direction : null,
    units: null,
    units_closed: null,
    entry_price: numberOrNull(row.entry_price),
    exit_price: numberOrNull(row.exit_price),
    realized_pl: numberOrNull(row.realized_pl),
    unrealized_pl: numberOrNull(row.unrealized_pl),
    tp: null,
    sl: null,
    recommendation: null,
    confidence: numberOrNull(edge.confidence),
    reason: null,
    raw_payload: {
      ...object(row.payload),
      ...object(row.raw_payload),
    },
    pair,
    direction: direction === 'long' || direction === 'short' ? direction : null,
    entry_time: type === 'opened' ? createdAt : null,
    exit_time: type === 'closed' || type === 'manual_close_executed'
      ? createdAt
      : null,
    pnl: numberOrNull(row.realized_pl ?? edge.pnl),
    win_loss: stringOrNull(edge.winLoss ?? edge.win_loss),
    session: stringOrNull(edge.session),
    spread: numberOrNull(edge.spread),
    signal_score: numberOrNull(edge.signalScore ?? edge.signal_score),
    trend: stringOrNull(edge.trend),
    volatility: stringOrNull(edge.volatility),
    market_regime: stringOrNull(edge.marketRegime ?? edge.market_regime),
    macro_bias: stringOrNull(edge.macroBias ?? edge.macro_bias),
    macro_risk: stringOrNull(edge.macroRisk ?? edge.macro_risk),
  };
}

/**
 * Dynamic profile fields are produced by the tested JS policy module. The cron
 * treats the envelope as data and forwards only a small, sanitized subset into
 * logs; no untyped value is used to bypass an execution gate.
 */
export async function loadAccountEdgeExecutionProfile(args: {
  userId: string;
  brokerAccountId: string;
}): Promise<any> {
  const { userId, brokerAccountId } = args;

  try {
    const supabase = getServerSupabase();
    const { data, error } = await supabase
      .from('trade_logs')
      .select(
        'id, user_id, created_at, event_type, status, pair, direction, ' +
        'entry_price, exit_price, realized_pl, unrealized_pl, payload, raw_payload',
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) {
      return {
        ...buildEdgeExecutionProfile({ overall: { outcomes: 0 }, edge: {} }),
        enabled: false,
        reason: `Per-account Edge Intelligence unavailable: ${error.message}`,
        rowsLoaded: 0,
        accountRows: 0,
      };
    }

    const allRows = (data ?? []) as unknown as CompactRow[];
    const accountRows = allRows.filter(
      (row) => extractBrokerAccountId(row) === brokerAccountId,
    );
    const mapped = accountRows.map(mapCompactRow);
    const report = generateAttributionReport(mapped, new Date().toISOString());
    const profile = buildEdgeExecutionProfile(report);

    return {
      ...profile,
      rowsLoaded: allRows.length,
      accountRows: accountRows.length,
      accountOutcomes: report.overall.outcomes,
      accountWinRate: report.overall.winRate,
      accountAvgPnl: report.overall.avgPnl,
    };
  } catch (err) {
    return {
      ...buildEdgeExecutionProfile({ overall: { outcomes: 0 }, edge: {} }),
      enabled: false,
      reason: `Per-account Edge Intelligence failed safely: ${
        err instanceof Error ? err.message : String(err)
      }`,
      rowsLoaded: 0,
      accountRows: 0,
    };
  }
}
