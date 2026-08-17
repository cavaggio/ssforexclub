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

function deepValue(root: unknown, keys: string[]): unknown {
  const queue: unknown[] = [root];
  const visited = new Set<unknown>();
  let inspected = 0;
  while (queue.length && inspected < 750) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);
    inspected += 1;
    const candidate = current as Record<string, unknown>;
    for (const key of keys) {
      if (candidate[key] !== undefined && candidate[key] !== null && candidate[key] !== '') return candidate[key];
    }
    for (const value of Object.values(candidate)) {
      if (value && typeof value === 'object') queue.push(value);
    }
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
  const executedSignal = record(executed.signal);
  const trade = record(rawPayload.trade);
  const close = record(rawPayload.close);
  const request = record(rawPayload.request);
  const result = record(rawPayload.result);
  return { executed, signal, executedSignal, trade, close, request, result };
}

function nestedMarketContext(...candidates: Record<string, unknown>[]) {
  for (const candidate of candidates) {
    if (Object.keys(candidate).length === 0) continue;
    const marketRegime = record(candidate.marketRegime);
    const volatility = record(marketRegime.volatility);
    const macro = record(candidate.macroAnalysis);
    const momentum = record(candidate.momentum);
    return { candidate, marketRegime, volatility, macro, momentum };
  }
  return {
    candidate: {} as Record<string, unknown>,
    marketRegime: {} as Record<string, unknown>,
    volatility: {} as Record<string, unknown>,
    macro: {} as Record<string, unknown>,
    momentum: {} as Record<string, unknown>,
  };
}

export function mapVisibleTradeLogRow(row: Record<string, unknown>): TradeLogRow {
  const payload = record(row.payload);
  const rawPayload = record(row.raw_payload);
  const { executed, signal, executedSignal, trade, close, request, result } = nestedRaw(rawPayload);
  const edge = record(payload.edge);
  const rawEdge = record(rawPayload.edge);
  const context = nestedMarketContext(signal, executedSignal, request, executed);
  const createdAt = str(row.created_at) ?? new Date(0).toISOString();
  const eventType = normalizeEventType(row.event_type, row.status);

  const tradeId = str(
    payload.trade_id,
    executed.tradeId,
    trade.tradeId,
    close.tradeId,
    result.tradeId,
    request.tradeId,
    deepValue(rawPayload, ['brokerTradeId', 'tradeId', 'tradeID']),
  );
  const brokerOrderId = str(
    payload.broker_order_id,
    executed.brokerOrderId,
    close.brokerOrderId,
    result.brokerOrderId,
    tradeId,
  );
  const pair = normalizePair(
    row.pair ?? edge.pair ?? rawEdge.pair ?? executed.pair ?? signal.pair ?? executedSignal.pair ?? request.pair ?? close.instrument,
  );
  const side = normalizeSide(
    row.direction ?? edge.direction ?? rawEdge.direction ?? executed.direction ?? signal.direction ?? executedSignal.direction ?? request.direction,
  );
  const realizedPnl = num(row.realized_pl, edge.pnl, rawEdge.pnl, close.pnl, result.pnl, executed.realizedPL);
  const explicitWinLoss = str(edge.winLoss, edge.win_loss, rawEdge.winLoss, rawEdge.win_loss);
  const winLoss = explicitWinLoss ?? (
    realizedPnl == null ? null : realizedPnl > 0 ? 'win' : realizedPnl < 0 ? 'loss' : 'breakeven'
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
    entry_price: num(row.entry_price, executed.fillPrice, trade.fillPrice, signal.entry, executedSignal.entry, request.entry),
    exit_price: num(row.exit_price, close.exitPrice, result.exitPrice, executed.exitPrice),
    realized_pl: realizedPnl,
    unrealized_pl: num(row.unrealized_pl, executed.unrealizedPL),
    tp: num(payload.tp, executed.takeProfit, signal.takeProfit, executedSignal.takeProfit, request.targetProfit),
    sl: num(payload.sl, executed.stopLoss, signal.stopLoss, executedSignal.stopLoss, request.stopLoss),
    recommendation: str(payload.recommendation),
    confidence: num(payload.confidence, edge.signalScore, rawEdge.signalScore, executed.confidence, signal.confidence, executedSignal.confidence),
    reason: str(payload.reason, close.message, result.message),
    raw_payload: row.raw_payload ?? row.payload ?? null,
    pair,
    direction: side,
    entry_time: str(edge.entryTime, edge.entry_time, rawEdge.entryTime, rawEdge.entry_time) ?? (eventType === 'opened' ? createdAt : null),
    exit_time: str(edge.exitTime, edge.exit_time, rawEdge.exitTime, rawEdge.exit_time) ?? (
      eventType === 'closed' || eventType === 'manual_close_executed' ? createdAt : null
    ),
    pnl: realizedPnl,
    win_loss: winLoss,
    session: str(edge.session, rawEdge.session, signal.session, executedSignal.session, request.session),
    spread: num(edge.spread, rawEdge.spread, signal.spreadPips, executedSignal.spreadPips, executed.spreadPips),
    signal_score: num(
      edge.signalScore,
      edge.signal_score,
      rawEdge.signalScore,
      rawEdge.signal_score,
      signal.score,
      executedSignal.score,
      executed.v3Score,
    ),
    trend: str(
      edge.trend,
      rawEdge.trend,
      signal.trend,
      executedSignal.trend,
      context.momentum.m15Trend,
      context.momentum.trend,
    ),
    volatility: str(
      edge.volatility,
      rawEdge.volatility,
      context.volatility.state,
      context.marketRegime.volatility,
      context.candidate.volatilityState,
    ),
    market_regime: str(
      edge.marketRegime,
      edge.market_regime,
      rawEdge.marketRegime,
      rawEdge.market_regime,
      context.marketRegime.regime,
    ),
    macro_bias: str(
      edge.macroBias,
      edge.macro_bias,
      rawEdge.macroBias,
      rawEdge.macro_bias,
      context.macro.bias,
    ),
    macro_risk: str(
      edge.macroRisk,
      edge.macro_risk,
      rawEdge.macroRisk,
      rawEdge.macro_risk,
      context.macro.risk,
    ),
    candidate_signal_id: str(deepValue(rawPayload, ['candidateSignalId', 'signalId', 'ictSignalId'])),
    entry_context: record(deepValue(rawPayload, ['entryContext'])),
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
