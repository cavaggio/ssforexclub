import 'server-only';

import { getServerSupabase } from './db';
import type { TradeEventType, TradeLogFilters, TradeLogRow } from './tradeLogs';

const SELECT =
  'id, user_id, created_at, event_type, status, pair, direction, ' +
  'entry_price, exit_price, realized_pl, unrealized_pl, payload, raw_payload';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function str(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function num(...values: unknown[]): number | null {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizePair(value: unknown): string | null {
  const pair = str(value);
  return pair ? pair.replace('/', '_').toUpperCase() : null;
}

function normalizeSide(value: unknown): 'long' | 'short' | null {
  const side = String(value ?? '').toLowerCase();
  if (side === 'long' || side === 'buy') return 'long';
  if (side === 'short' || side === 'sell') return 'short';
  return null;
}

function normalizeEventType(eventType: unknown, status: unknown): TradeEventType {
  const raw = String(eventType ?? status ?? '').toLowerCase();
  if (raw === 'opened' || raw === 'open') return 'opened';
  if (raw === 'closed' || raw === 'close') return 'closed';
  if (raw === 'partial_closed' || raw === 'partial close' || raw === 'partial') return 'partial_closed';
  if (raw === 'manual_close_executed') return 'manual_close_executed';
  if (raw === 'tp_updated') return 'tp_updated';
  if (raw === 'sl_updated') return 'sl_updated';
  if (raw === 'reassessed') return 'reassessed';
  if (raw === 'auto_close_recommended') return 'auto_close_recommended';
  return 'error';
}

function nestedRaw(rawPayload: Record<string, unknown>) {
  const executed = record(rawPayload.executed);
  const signal = record(rawPayload.signal);
  const trade = record(rawPayload.trade);
  const close = record(rawPayload.close);
  const request = record(rawPayload.request);
  const result = record(rawPayload.result);
  return { executed, signal, trade, close, request, result };
}

export function mapVisibleTradeLogRow(row: Record<string, unknown>): TradeLogRow {
  const payload = record(row.payload);
  const rawPayload = record(row.raw_payload);
  const { executed, signal, trade, close, request, result } = nestedRaw(rawPayload);
  const edge = record(payload.edge);
  const createdAt = str(row.created_at) ?? new Date(0).toISOString();
  const eventType = normalizeEventType(row.event_type, row.status);

  const tradeId = str(
    payload.trade_id,
    executed.tradeId,
    trade.tradeId,
    close.tradeId,
    result.tradeId,
    request.tradeId,
  );
  const brokerOrderId = str(
    payload.broker_order_id,
    executed.brokerOrderId,
    close.brokerOrderId,
    result.brokerOrderId,
    tradeId,
  );
  const pair = normalizePair(
    row.pair ?? edge.pair ?? executed.pair ?? signal.pair ?? request.pair ?? close.instrument,
  );
  const side = normalizeSide(
    row.direction ?? edge.direction ?? executed.direction ?? signal.direction ?? request.direction,
  );

  return {
    id: str(row.id) ?? `${createdAt}:${tradeId ?? pair ?? 'trade'}`,
    created_at: createdAt,
    user_id: str(row.user_id) ?? '',
    organization_id: null,
    broker: str(payload.broker) ?? '',
    broker_account_id: str(payload.broker_account_id),
    environment: str(payload.environment) ?? '',
    event_type: eventType,
    instrument: pair,
    trade_id: tradeId,
    broker_order_id: brokerOrderId,
    side,
    units: num(payload.units, executed.units, trade.units, result.units),
    units_closed: num(payload.units_closed, close.unitsClosed, result.unitsClosed),
    entry_price: num(row.entry_price, executed.fillPrice, trade.fillPrice, signal.entry, request.entry),
    exit_price: num(row.exit_price, close.exitPrice, result.exitPrice, executed.exitPrice),
    realized_pl: num(row.realized_pl, close.pnl, result.pnl, executed.realizedPL),
    unrealized_pl: num(row.unrealized_pl, executed.unrealizedPL),
    tp: num(payload.tp, executed.takeProfit, signal.takeProfit, request.targetProfit),
    sl: num(payload.sl, executed.stopLoss, signal.stopLoss, request.stopLoss),
    recommendation: str(payload.recommendation),
    confidence: num(payload.confidence, executed.confidence, signal.confidence),
    reason: str(payload.reason, close.message, result.message),
    raw_payload: row.raw_payload ?? row.payload ?? null,
    pair,
    direction: side,
    entry_time: eventType === 'opened' ? createdAt : null,
    exit_time: eventType === 'closed' || eventType === 'manual_close_executed' ? createdAt : null,
    pnl: num(row.realized_pl, close.pnl, result.pnl, executed.realizedPL),
    win_loss: null,
    session: null,
    spread: null,
    signal_score: null,
    trend: null,
    volatility: null,
    market_regime: null,
    macro_bias: null,
    macro_risk: null,
  };
}

export async function listVisibleTradeLogsForUser(
  userId: string,
  filters: TradeLogFilters = {},
): Promise<{ rows: TradeLogRow[]; nextCursor: string | null }> {
  if (!userId) return { rows: [], nextCursor: null };

  const requestedLimit = Math.max(1, Math.min(200, filters.limit ?? 50));
  const fetchLimit = filters.tradeId ? 500 : Math.min(500, requestedLimit + 1);
  const supabase = getServerSupabase();

  let query = supabase
    .from('trade_logs')
    .select(SELECT)
    .eq('user_id', userId);

  if (filters.instrument) query = query.eq('pair', normalizePair(filters.instrument));
  if (filters.startDate) query = query.gte('created_at', filters.startDate);
  if (filters.endDate) query = query.lte('created_at', filters.endDate);
  if (filters.cursor) query = query.lt('created_at', filters.cursor);

  query = query.order('created_at', { ascending: false }).limit(fetchLimit);
  const { data, error } = await query;
  if (error) {
    console.warn(`[VISIBLE_TRADE_LOGS] query failed: ${error.message}`);
    return { rows: [], nextCursor: null };
  }

  let mapped = ((data ?? []) as unknown as Record<string, unknown>[]).map(mapVisibleTradeLogRow);
  if (filters.eventType) mapped = mapped.filter((row) => row.event_type === filters.eventType);
  if (filters.tradeId) mapped = mapped.filter((row) => row.trade_id === filters.tradeId);

  const rows = mapped.slice(0, requestedLimit);
  const nextCursor = mapped.length > requestedLimit
    ? rows[rows.length - 1]?.created_at ?? null
    : null;

  return { rows, nextCursor };
}

export const TRADE_ACTIVITY_EVENT_TYPES = new Set<TradeEventType>([
  'opened',
  'closed',
  'partial_closed',
  'manual_close_executed',
]);

export function lifecycleTradeRows(rows: TradeLogRow[]): TradeLogRow[] {
  return rows.filter((row) => TRADE_ACTIVITY_EVENT_TYPES.has(row.event_type));
}
