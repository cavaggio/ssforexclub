import 'server-only';

import { getServerSupabase } from './db';
import type { TradeLogRow } from './tradeLogs';
import { canonicalizeTradeActivityRows } from './tradeActivityCanonical.js';
import { lifecycleTradeRows, listVisibleTradeLogsForUser } from './visibleTradeLogs';

export const EDGE_TRADES_PER_ACCOUNT = 25;
const EDGE_HISTORY_SCAN_LIMIT = 2000;
const TRADE_LOG_PAGE_LIMIT = 200;
const TRADE_LOG_MAX_PAGES = 10;

type JsonRecord = Record<string, unknown>;

type LifecycleRow = {
  id: string;
  user_id: string;
  broker_account_id: string;
  environment: string | null;
  engine: string | null;
  broker_trade_id: string;
  candidate_signal_id?: string | null;
  pair: string | null;
  direction: string | null;
  opened_at: string | null;
  closed_at: string | null;
  state: string | null;
  result: string | null;
  entry_price: number | null;
  exit_price: number | null;
  units: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  realized_pl: number | null;
  entry_context?: unknown;
  opening_snapshot: unknown;
  broker_snapshot: unknown;
};

export type EdgeAccountHistory = {
  brokerAccountId: string;
  tradesLoaded: number;
  rows: TradeLogRow[];
};

export type EdgeHistoryLoadResult = {
  accounts: EdgeAccountHistory[];
  lifecycleRowsScanned: number;
  tradesPerAccount: number;
  sourceMode: 'actual_trade_lifecycles' | 'trade_log_fallback';
  sourceWarning: string | null;
};

function object(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const row = error as Record<string, unknown>;
    const parts = [row.message, row.details, row.hint, row.code]
      .map(stringValue)
      .filter((value): value is string => Boolean(value));
    if (parts.length) return parts.join(' · ');
    try {
      return JSON.stringify(error);
    } catch {
      return 'Unknown database error';
    }
  }
  return String(error ?? 'Unknown database error');
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
    const candidate = current as JsonRecord;
    for (const key of keys) {
      if (candidate[key] !== undefined && candidate[key] !== null && candidate[key] !== '') {
        return candidate[key];
      }
    }
    for (const value of Object.values(candidate)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}

function firstString(roots: unknown[], keys: string[]): string | null {
  for (const root of roots) {
    const value = deepValue(root, keys);
    const scalar = stringValue(value);
    if (scalar) return scalar;
  }
  return null;
}

function firstNumber(roots: unknown[], keys: string[]): number | null {
  for (const root of roots) {
    const value = deepValue(root, keys);
    const scalar = numberValue(value);
    if (scalar !== null) return scalar;
  }
  return null;
}

function normalizePair(value: unknown): string | null {
  const pair = stringValue(value);
  return pair ? pair.replace('/', '_').toUpperCase() : null;
}

function normalizeSide(value: unknown): 'long' | 'short' | null {
  const side = String(value ?? '').toLowerCase();
  if (side === 'long' || side === 'buy' || side === 'bullish') return 'long';
  if (side === 'short' || side === 'sell' || side === 'bearish') return 'short';
  return null;
}

function normalizeOutcome(value: unknown): string | null {
  const result = String(value ?? '').toLowerCase();
  if (result === 'win' || result === 'loss' || result === 'breakeven') return result;
  return null;
}

function makeBaseRow(lifecycle: LifecycleRow, createdAt: string): TradeLogRow {
  const openingSnapshot = object(lifecycle.opening_snapshot);
  const recoveredEntryContext = deepValue(openingSnapshot, ['entryContext']);
  const entryContext = object(lifecycle.entry_context ?? recoveredEntryContext);
  const roots = [entryContext, openingSnapshot];
  const pair = normalizePair(lifecycle.pair ?? firstString(roots, ['pair', 'instrument']));
  const direction = normalizeSide(lifecycle.direction ?? firstString(roots, ['direction', 'side']));
  const candidateSignalId = stringValue(lifecycle.candidate_signal_id)
    ?? firstString(roots, ['candidateSignalId', 'signalId', 'ictSignalId']);

  return {
    id: lifecycle.id,
    created_at: createdAt,
    user_id: lifecycle.user_id,
    organization_id: null,
    broker: 'oanda',
    broker_account_id: lifecycle.broker_account_id,
    environment: lifecycle.environment ?? 'unknown',
    event_type: 'opened',
    instrument: pair,
    trade_id: lifecycle.broker_trade_id,
    broker_order_id: null,
    side: direction,
    units: numberValue(lifecycle.units),
    units_closed: null,
    entry_price: numberValue(lifecycle.entry_price),
    exit_price: null,
    realized_pl: null,
    unrealized_pl: null,
    tp: numberValue(lifecycle.take_profit),
    sl: numberValue(lifecycle.stop_loss),
    recommendation: null,
    confidence: firstNumber(roots, ['confidence']),
    reason: null,
    raw_payload: openingSnapshot,
    pair,
    direction,
    entry_time: lifecycle.opened_at,
    exit_time: null,
    pnl: null,
    win_loss: null,
    session: firstString(roots, ['session', 'killzone', 'sessionName']),
    spread: firstNumber(roots, ['spreadPips', 'spread']),
    signal_score: firstNumber(roots, ['signalScore', 'signal_score', 'v3Score']),
    trend: firstString(roots, ['trend', 'h1Trend', 'h1Structure']),
    volatility: firstString(roots, ['volatilityState', 'volatility']),
    market_regime: firstString(roots, ['market_regime', 'regime']),
    macro_bias: firstString(roots, ['macroBias', 'macro_bias']),
    macro_risk: firstString(roots, ['macroRisk', 'macro_risk']),
    candidate_signal_id: candidateSignalId,
    entry_context: entryContext,
  };
}

function lifecycleToTradeRows(lifecycle: LifecycleRow): TradeLogRow[] {
  const openedAt = lifecycle.opened_at ?? lifecycle.closed_at ?? new Date(0).toISOString();
  const base = makeBaseRow(lifecycle, openedAt);
  const outcome = normalizeOutcome(lifecycle.result);
  const rows: TradeLogRow[] = [base];

  if (lifecycle.closed_at && outcome) {
    rows.push({
      ...base,
      id: `${lifecycle.id}:close`,
      created_at: lifecycle.closed_at,
      event_type: 'closed',
      entry_time: lifecycle.opened_at,
      exit_time: lifecycle.closed_at,
      exit_price: numberValue(lifecycle.exit_price),
      realized_pl: numberValue(lifecycle.realized_pl),
      pnl: numberValue(lifecycle.realized_pl),
      win_loss: outcome,
      raw_payload: object(lifecycle.broker_snapshot),
    });
  }

  return rows;
}

function accountsFromLifecycles(rows: LifecycleRow[]): EdgeAccountHistory[] {
  const grouped = new Map<string, LifecycleRow[]>();
  for (const raw of rows) {
    const accountId = stringValue(raw.broker_account_id);
    if (!accountId) continue;
    const accountRows = grouped.get(accountId) ?? [];
    if (accountRows.length >= EDGE_TRADES_PER_ACCOUNT) continue;
    accountRows.push(raw);
    grouped.set(accountId, accountRows);
  }

  return [...grouped.entries()]
    .map(([brokerAccountId, lifecycles]) => ({
      brokerAccountId,
      tradesLoaded: lifecycles.length,
      rows: lifecycles.flatMap(lifecycleToTradeRows),
    }))
    .sort((a, b) => a.brokerAccountId.localeCompare(b.brokerAccountId));
}

async function loadPersistentTradeLogRows(userId: string): Promise<TradeLogRow[]> {
  const output: TradeLogRow[] = [];
  let cursor: string | undefined;

  for (let pageIndex = 0; pageIndex < TRADE_LOG_MAX_PAGES; pageIndex += 1) {
    const page = await listVisibleTradeLogsForUser(userId, {
      limit: TRADE_LOG_PAGE_LIMIT,
      cursor,
    });
    output.push(...page.rows);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  return output;
}

function accountsFromTradeLogs(rows: TradeLogRow[]): EdgeAccountHistory[] {
  const grouped = new Map<string, TradeLogRow[]>();
  for (const row of lifecycleTradeRows(rows)) {
    const accountId = stringValue(row.broker_account_id);
    if (!accountId) continue;
    const list = grouped.get(accountId) ?? [];
    list.push(row);
    grouped.set(accountId, list);
  }

  const accounts: EdgeAccountHistory[] = [];
  for (const [brokerAccountId, accountRows] of grouped.entries()) {
    const canonical = canonicalizeTradeActivityRows(accountRows) as TradeLogRow[];
    const completedTradeIds = new Set<string>();

    for (const row of canonical) {
      if (row.event_type !== 'closed' && row.event_type !== 'manual_close_executed') continue;
      if (!row.trade_id) continue;
      completedTradeIds.add(row.trade_id);
      if (completedTradeIds.size >= EDGE_TRADES_PER_ACCOUNT) break;
    }

    if (!completedTradeIds.size) continue;
    accounts.push({
      brokerAccountId,
      tradesLoaded: completedTradeIds.size,
      rows: canonical.filter((row) => Boolean(row.trade_id && completedTradeIds.has(row.trade_id))),
    });
  }

  return accounts.sort((a, b) => a.brokerAccountId.localeCompare(b.brokerAccountId));
}

/**
 * Persistent Edge Intelligence history, intentionally separate from the dashboard's
 * New York "Today's Trade Activity" window. The preferred source is the reconciled
 * broker lifecycle table. If that table or a newer optional column is unavailable
 * in production, the loader falls back to the same persistent history backing the
 * dashboard Trade Log, still capped at the latest 25 completed trades per account.
 */
export async function loadEdgeHistoryByAccount(userId: string): Promise<EdgeHistoryLoadResult> {
  if (!userId) {
    return {
      accounts: [],
      lifecycleRowsScanned: 0,
      tradesPerAccount: EDGE_TRADES_PER_ACCOUNT,
      sourceMode: 'actual_trade_lifecycles',
      sourceWarning: null,
    };
  }

  const { data, error } = await getServerSupabase()
    .from('actual_trade_lifecycles')
    .select(
      'id,user_id,broker_account_id,environment,engine,broker_trade_id,' +
      'pair,direction,opened_at,closed_at,state,result,entry_price,exit_price,units,' +
      'stop_loss,take_profit,realized_pl,opening_snapshot,broker_snapshot',
    )
    .eq('user_id', userId)
    .eq('state', 'closed')
    .in('result', ['win', 'loss', 'breakeven'])
    .order('closed_at', { ascending: false, nullsFirst: false })
    .limit(EDGE_HISTORY_SCAN_LIMIT);

  if (!error) {
    const lifecycleRows = (data ?? []) as unknown as LifecycleRow[];
    const accounts = accountsFromLifecycles(lifecycleRows);
    if (accounts.length) {
      return {
        accounts,
        lifecycleRowsScanned: lifecycleRows.length,
        tradesPerAccount: EDGE_TRADES_PER_ACCOUNT,
        sourceMode: 'actual_trade_lifecycles',
        sourceWarning: null,
      };
    }
  }

  const persistentTradeLogs = await loadPersistentTradeLogRows(userId);
  const fallbackAccounts = accountsFromTradeLogs(persistentTradeLogs);
  const primaryReason = error
    ? `Reconciled lifecycle history unavailable: ${errorText(error)}.`
    : 'No completed reconciled lifecycle rows were available.';

  return {
    accounts: fallbackAccounts,
    lifecycleRowsScanned: persistentTradeLogs.length,
    tradesPerAccount: EDGE_TRADES_PER_ACCOUNT,
    sourceMode: 'trade_log_fallback',
    sourceWarning: `${primaryReason} Using persistent Trade Log history instead.`,
  };
}
