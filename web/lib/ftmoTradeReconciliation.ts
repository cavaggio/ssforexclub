import 'server-only';

import crypto from 'crypto';
import { getServerSupabase } from './db';
import { sanitizePayload } from './tradeLogs';
import { computeActualRealizedR, computeTradeExcursion } from './actualTradeReconciliationCore.js';
import { classifyIctTradeFailure } from '../../server/ictTradeContext.js';

type JsonRecord = Record<string, any>;

const HISTORY_BRIDGE_VERSION = '1.24';
const POLL_MS = 250;
const POLL_TIMEOUT_MS = 15_000;

function finite(value: unknown, fallback: number | null = null): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function text(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function versionAtLeast(actual: unknown, minimum: string): boolean {
  const parse = (value: unknown) => String(value ?? '').trim().split('.').map((part) => Number(part));
  const a = parse(actual);
  const m = parse(minimum);
  if (!a.length || !m.length || a.some((part) => !Number.isFinite(part)) || m.some((part) => !Number.isFinite(part))) return false;
  const width = Math.max(a.length, m.length);
  for (let i = 0; i < width; i += 1) {
    if ((a[i] || 0) > (m[i] || 0)) return true;
    if ((a[i] || 0) < (m[i] || 0)) return false;
  }
  return true;
}

function deepValue(root: unknown, keys: string[]): unknown {
  const queue: unknown[] = [root];
  const visited = new Set<unknown>();
  let inspected = 0;
  while (queue.length && inspected < 1000) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);
    inspected += 1;
    const record = current as JsonRecord;
    for (const key of keys) {
      if (record[key] !== undefined && record[key] !== null && record[key] !== '') return record[key];
    }
    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}

function normalizeEngine(value: unknown): 'ict' | 'ppr' | 'v3' | null {
  const engine = String(value || '').trim().toLowerCase();
  return ['ict', 'ppr', 'v3'].includes(engine) ? engine as 'ict' | 'ppr' | 'v3' : null;
}

function normalizePair(value: unknown): string | null {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return null;
  const base = raw.split('.')[0].replace('/', '').replace('_', '');
  return /^[A-Z]{6}$/.test(base) ? `${base.slice(0, 3)}_${base.slice(3)}` : null;
}

function directionOf(value: unknown): 'long' | 'short' | null {
  const direction = String(value || '').trim().toLowerCase();
  if (['long', 'buy', 'bullish'].includes(direction)) return 'long';
  if (['short', 'sell', 'bearish'].includes(direction)) return 'short';
  return null;
}

function isOpeningDeal(deal: JsonRecord): boolean {
  return String(deal.entry || '').toUpperCase() === 'DEAL_ENTRY_IN';
}

function isClosingDeal(deal: JsonRecord): boolean {
  const entry = String(deal.entry || '').toUpperCase();
  return entry === 'DEAL_ENTRY_OUT' || entry === 'DEAL_ENTRY_OUT_BY' || entry === 'DEAL_ENTRY_INOUT';
}

function weightedPrice(deals: JsonRecord[]): number | null {
  let value = 0;
  let volume = 0;
  for (const deal of deals) {
    const price = finite(deal.price);
    const lots = finite(deal.volume);
    if (price == null || lots == null || lots <= 0) continue;
    value += price * lots;
    volume += lots;
  }
  return volume > 0 ? value / volume : null;
}

function epochIso(value: unknown): string | null {
  const ms = finite(value);
  return ms != null && ms > 0 ? new Date(ms).toISOString() : null;
}

function riskUsdFromContext(context: JsonRecord, rawPayload: JsonRecord): number | null {
  const direct = finite(deepValue(rawPayload, ['riskUSD', 'riskUsd', 'riskAmount']));
  if (direct != null && direct > 0) return direct;
  const balance = finite(context?.executionRisk?.balance);
  const riskPercent = finite(context?.executionRisk?.effectiveRiskPercent);
  if (balance != null && balance > 0 && riskPercent != null && riskPercent > 0) {
    return +(balance * (riskPercent / 100)).toFixed(2);
  }
  return null;
}

async function latestTerminal(userId: string, accountLogin: string): Promise<JsonRecord | null> {
  const { data, error } = await getServerSupabase()
    .from('mt5_ea_terminals')
    .select('account_login,terminal_id,status,last_heartbeat_at,bridge_version,risk_policy_version')
    .eq('user_id', userId)
    .eq('account_login', accountLogin)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function requestHistory(userId: string, accountLogin: string, lookbackDays: number) {
  const terminal = await latestTerminal(userId, accountLogin);
  if (!terminal?.terminal_id) {
    return { available: false, reason: 'No FTMO MT5 terminal is registered for outcome reconciliation.', deals: [] as JsonRecord[] };
  }
  if (!versionAtLeast(terminal.bridge_version, HISTORY_BRIDGE_VERSION)) {
    return {
      available: false,
      reason: `SignalStackBridge ${HISTORY_BRIDGE_VERSION}+ is required for exact FTMO deal-history reconciliation; current=${terminal.bridge_version || 'unknown'}.`,
      deals: [] as JsonRecord[],
    };
  }
  const heartbeatAt = terminal.last_heartbeat_at ? Date.parse(String(terminal.last_heartbeat_at)) : NaN;
  if (terminal.status !== 'connected' || !Number.isFinite(heartbeatAt) || Date.now() - heartbeatAt > 120_000) {
    return { available: false, reason: 'FTMO MT5 terminal heartbeat is not fresh enough for history reconciliation.', deals: [] as JsonRecord[] };
  }

  const supabase = getServerSupabase();
  const { data: command, error } = await supabase
    .from('mt5_ea_commands')
    .insert({
      account_login: accountLogin,
      terminal_id: terminal.terminal_id,
      command_type: 'history_list',
      payload: { lookbackDays },
      idempotency_key: `ftmo-history:${userId}:${accountLogin}:${crypto.randomUUID()}`,
      status: 'pending',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    })
    .select('id')
    .single();
  if (error || !command?.id) throw new Error(`FTMO history command queue failed: ${error?.message || 'no command id'}`);

  const started = Date.now();
  while (Date.now() - started < POLL_TIMEOUT_MS) {
    const { data, error: readError } = await supabase
      .from('mt5_ea_commands')
      .select('status,result,error')
      .eq('id', command.id)
      .single();
    if (readError) throw readError;
    if (data?.status === 'completed') {
      const deals = Array.isArray(data.result?.deals) ? data.result.deals as JsonRecord[] : [];
      return { available: true, reason: null, deals, bridgeVersion: terminal.bridge_version };
    }
    if (data?.status === 'failed' || data?.status === 'expired') {
      return { available: false, reason: data.error || `FTMO history command ${data.status}`, deals: [] as JsonRecord[] };
    }
    await sleep(POLL_MS);
  }
  return { available: false, reason: 'FTMO history command timed out.', deals: [] as JsonRecord[] };
}

function groupDeals(deals: JsonRecord[]) {
  const grouped = new Map<string, JsonRecord[]>();
  for (const deal of deals) {
    const id = String(deal.positionIdentifier || '').trim();
    if (!id) continue;
    const rows = grouped.get(id) || [];
    rows.push(deal);
    grouped.set(id, rows);
  }
  for (const rows of grouped.values()) rows.sort((a, b) => Number(a.timeEpochMs || 0) - Number(b.timeEpochMs || 0));
  return grouped;
}

function excursionForTicket(ticket: string, pair: string, direction: string, entryPrice: number | null, stopLoss: number | null, positionCommands: JsonRecord[]) {
  if (entryPrice == null || stopLoss == null) return { mfePips: null, maePips: null, mfeR: null, maeR: null };
  const candles: JsonRecord[] = [];
  for (const command of positionCommands) {
    const positions = Array.isArray(command?.result?.positions) ? command.result.positions : [];
    for (const position of positions) {
      if (String(position.ticket || position.positionIdentifier || '') !== ticket) continue;
      const price = finite(position.currentPrice);
      if (price == null) continue;
      candles.push({ high: price, low: price });
    }
  }
  return computeTradeExcursion({ pair, direction, entryPrice, stopLoss, candles });
}

async function applyClosedTradeAudits(rows: JsonRecord[], now: Date): Promise<number> {
  const closed = rows.filter((row) => row.closed_at);
  if (!closed.length) return 0;
  const supabase = getServerSupabase();
  const adjustmentRows = closed.map((row) => ({
    user_id: row.user_id,
    broker_account_id: row.broker_account_id,
    environment: row.environment || 'challenge',
    engine: row.engine,
    pair: row.pair,
    direction: row.direction,
    observed_at: row.closed_at,
    mode: 'active',
    recommendation_stage: 'post_trade_outcome',
    sample_size: 1,
    original_confidence: null,
    market_study_adjustment: 0,
    engine_trade_adjustment: 0,
    combined_adjustment: 0,
    final_confidence: null,
    component_adjustments: [{
      type: 'actual_ftmo_broker_outcome',
      realizedR: row.realized_r,
      mfeR: row.mfe_r,
      maeR: row.mae_r,
    }],
    reasons: row.failure_reasons || [],
    hard_gates_preserved: ['ict_corrective_gate', 'pair_playbook_negative_expectancy', 'risk', 'spread', 'duplicate'],
    candidate_snapshot: {
      candidateSignalId: row.candidate_signal_id,
      brokerTradeId: row.broker_trade_id,
      entryContext: row.entry_context,
      broker: 'ftmo',
    },
    adjustment_type: 'post_trade_outcome',
    applied: true,
    applied_at: now.toISOString(),
    source_trade_lifecycle_id: row.id,
    source_signal_observation_id: row.signal_observation_id || null,
    failure_reasons: row.failure_reasons || [],
  }));

  const { data: audits, error } = await supabase
    .from('engine_learning_adjustment_audit')
    .upsert(adjustmentRows, { onConflict: 'source_trade_lifecycle_id,adjustment_type' })
    .select('id,source_trade_lifecycle_id');
  if (error) throw error;

  await Promise.all((audits || []).map((audit: JsonRecord) => supabase
    .from('actual_trade_lifecycles')
    .update({
      applied_learning_audit_id: audit.id,
      learning_applied: true,
      updated_at: now.toISOString(),
    })
    .eq('id', audit.source_trade_lifecycle_id)));

  return (audits || []).length;
}

export type FtmoTradeReconciliationResult = {
  ok: boolean;
  brokerAccountId: string;
  openingsConsidered: number;
  tradesUpserted: number;
  closedTrades: number;
  openTrades: number;
  unresolvedTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  learningAdjustmentsApplied: number;
  exactHistoryAvailable: boolean;
  historyDeals: number;
  warning?: string;
  error?: string;
};

export async function reconcileFtmoTradesForAccount({
  userId,
  brokerAccountId,
  environment = 'challenge',
  lookbackDays = 14,
  now = new Date(),
}: {
  userId: string;
  brokerAccountId: string;
  environment?: string;
  lookbackDays?: number;
  now?: Date;
}): Promise<FtmoTradeReconciliationResult> {
  const base: FtmoTradeReconciliationResult = {
    ok: true,
    brokerAccountId,
    openingsConsidered: 0,
    tradesUpserted: 0,
    closedTrades: 0,
    openTrades: 0,
    unresolvedTrades: 0,
    wins: 0,
    losses: 0,
    breakevens: 0,
    learningAdjustmentsApplied: 0,
    exactHistoryAvailable: false,
    historyDeals: 0,
  };

  try {
    const supabase = getServerSupabase();
    const boundedDays = Math.max(1, Math.min(30, Math.floor(Number(lookbackDays) || 14)));
    const cutoff = new Date(now.getTime() - boundedDays * 86_400_000).toISOString();

    const [{ data: openingLogs, error: logError }, history, { data: positionCommands, error: positionsError }] = await Promise.all([
      supabase
        .from('trade_logs')
        .select('id,user_id,broker,broker_account_id,environment,instrument,trade_id,broker_trade_id,event_type,side,entry_price,sl,tp,raw_payload,created_at')
        .eq('user_id', userId)
        .eq('broker_account_id', brokerAccountId)
        .eq('broker', 'ftmo')
        .eq('event_type', 'opened')
        .gte('created_at', cutoff)
        .order('created_at', { ascending: true }),
      requestHistory(userId, brokerAccountId, boundedDays),
      supabase
        .from('mt5_ea_commands')
        .select('created_at,result')
        .eq('account_login', brokerAccountId)
        .eq('command_type', 'positions_list')
        .eq('status', 'completed')
        .gte('created_at', cutoff)
        .order('created_at', { ascending: true })
        .limit(5000),
    ]);
    if (logError) throw logError;
    if (positionsError) throw positionsError;

    const openings = (openingLogs || []) as JsonRecord[];
    base.openingsConsidered = openings.length;
    base.exactHistoryAvailable = history.available;
    base.historyDeals = history.deals.length;
    if (!history.available) base.warning = history.reason || 'Exact FTMO history unavailable.';

    const grouped = groupDeals(history.deals);
    const activeTickets = new Set<string>();
    const latestPositions = (positionCommands || []).at(-1)?.result?.positions;
    for (const position of Array.isArray(latestPositions) ? latestPositions : []) {
      activeTickets.add(String(position.ticket || position.positionIdentifier || ''));
    }

    const lifecycleRows: JsonRecord[] = [];
    for (const opening of openings) {
      const rawPayload = opening.raw_payload && typeof opening.raw_payload === 'object' ? opening.raw_payload : {};
      const engine = normalizeEngine(deepValue(rawPayload, ['engine', 'strategy', 'entryStrategy']));
      const tradeId = String(opening.broker_trade_id || opening.trade_id || '').trim();
      const pair = normalizePair(opening.instrument || deepValue(rawPayload, ['pair', 'symbol']));
      const direction = directionOf(opening.side || deepValue(rawPayload, ['direction', 'side', 'signal']));
      if (!engine || !tradeId || !pair || !direction) continue;

      const entryContextValue = deepValue(rawPayload, ['entryContext']);
      const entryContext = entryContextValue && typeof entryContextValue === 'object' ? entryContextValue as JsonRecord : {};
      const timeframe = entryContext.timeframeState || {};
      const authorization = entryContext.m5Authorization || {};
      const candidateSignalId = text(entryContext.candidateSignalId || deepValue(rawPayload, ['candidateSignalId', 'signalId', 'ictSignalId']));
      const deals = grouped.get(tradeId) || [];
      const entryDeals = deals.filter(isOpeningDeal);
      const closingDeals = deals.filter(isClosingDeal);
      const initialVolume = entryDeals.reduce((sum, deal) => sum + (finite(deal.volume, 0) || 0), 0);
      const closedVolume = closingDeals.reduce((sum, deal) => sum + (finite(deal.volume, 0) || 0), 0);
      const fullyClosed = history.available && initialVolume > 0 && closedVolume >= initialVolume - 1e-6;
      const definitelyOpen = activeTickets.has(tradeId);
      const state = fullyClosed ? 'closed' : definitelyOpen ? 'open' : history.available ? 'unresolved' : 'unresolved';
      const entryPrice = weightedPrice(entryDeals) ?? finite(opening.entry_price);
      const exitPrice = fullyClosed ? weightedPrice(closingDeals) : null;
      const stopLoss = finite(opening.sl);
      const takeProfit = finite(opening.tp);
      const realizedPl = fullyClosed
        ? +deals.reduce((sum, deal) =>
            sum +
            (finite(deal.profit, 0) || 0) +
            (finite(deal.commission, 0) || 0) +
            (finite(deal.swap, 0) || 0) +
            (finite(deal.fee, 0) || 0), 0).toFixed(2)
        : null;
      const riskUsd = riskUsdFromContext(entryContext, rawPayload);
      const realizedR = fullyClosed ? computeActualRealizedR({
        direction,
        entryPrice,
        exitPrice,
        stopLoss,
        realizedPl,
        riskUsd,
      }) : null;
      const excursion = excursionForTicket(
        tradeId,
        pair,
        direction,
        entryPrice,
        stopLoss,
        (positionCommands || []) as JsonRecord[],
      );
      const lastClose = closingDeals.at(-1);
      const exitReason = fullyClosed ? String(lastClose?.reason || 'mt5_broker_trade_closed').toLowerCase() : null;
      const failure = fullyClosed && engine === 'ict'
        ? classifyIctTradeFailure({
            entryContext,
            realizedR,
            mfeR: excursion.mfeR,
            maeR: excursion.maeR,
            exitReason,
          })
        : { failureReasons: [], adjustment: null, exitReason };
      const result = !fullyClosed
        ? state === 'open' ? 'open' : 'unresolved'
        : realizedPl == null || Math.abs(realizedPl) < 0.000001
          ? 'breakeven'
          : realizedPl > 0 ? 'win' : 'loss';

      lifecycleRows.push({
        user_id: userId,
        broker_account_id: brokerAccountId,
        environment: opening.environment || environment,
        broker: 'ftmo',
        engine,
        broker_trade_id: tradeId,
        source_trade_log_id: opening.id,
        candidate_signal_id: candidateSignalId,
        pair,
        direction,
        opened_at: epochIso(entryDeals[0]?.timeEpochMs) || opening.created_at,
        closed_at: fullyClosed ? epochIso(lastClose?.timeEpochMs) : null,
        state,
        result,
        entry_price: entryPrice,
        exit_price: exitPrice,
        units: null,
        stop_loss: stopLoss,
        take_profit: takeProfit,
        risk_usd: riskUsd,
        realized_pl: realizedPl,
        realized_r: realizedR,
        entry_context: entryContext,
        d1_state: timeframe.d1 || null,
        h4_state: timeframe.h4 || null,
        h1_state: timeframe.h1Structure || null,
        h1_momentum: entryContext.h1Momentum || {},
        m5_authorization: authorization,
        m5_trigger_age_bars: finite(authorization.triggerAgeBars),
        po3_stage: entryContext.powerOfThree?.stage || null,
        htf_liquidity_condition: entryContext.htfLiquidityCondition || {},
        exit_reason: fullyClosed ? failure.exitReason || exitReason : null,
        mfe_pips: excursion.mfePips,
        mae_pips: excursion.maePips,
        mfe_r: excursion.mfeR,
        mae_r: excursion.maeR,
        failure_reasons: fullyClosed ? failure.failureReasons || [] : [],
        learning_adjustment: fullyClosed ? failure.adjustment || null : null,
        opening_transaction_ids: entryDeals.map((deal) => String(deal.ticket || '')).filter(Boolean),
        closing_transaction_ids: closingDeals.map((deal) => String(deal.ticket || '')).filter(Boolean),
        engine_attribution_source: 'ftmo_trade_log_open',
        actual_outcome_source: fullyClosed
          ? 'ftmo_mt5_deal_history'
          : history.available ? 'ftmo_mt5_history_unresolved' : 'awaiting_ftmo_mt5_history',
        opening_snapshot: sanitizePayload(rawPayload),
        broker_snapshot: sanitizePayload({ deals }),
        reconciled_at: now.toISOString(),
        updated_at: now.toISOString(),
      });
    }

    if (!lifecycleRows.length) return base;

    const candidateIds = lifecycleRows.map((row) => row.candidate_signal_id).filter(Boolean);
    if (candidateIds.length) {
      const { data: observations, error } = await supabase
        .from('signal_observations')
        .select('id,candidate_signal_id,broker_trade_id,observed_at')
        .eq('user_id', userId)
        .eq('broker_account_id', brokerAccountId)
        .in('candidate_signal_id', candidateIds);
      if (error) throw error;
      for (const row of lifecycleRows) {
        const match = (observations || [])
          .filter((observation: JsonRecord) => observation.candidate_signal_id === row.candidate_signal_id)
          .sort((a: JsonRecord, b: JsonRecord) => Date.parse(b.observed_at) - Date.parse(a.observed_at))[0];
        row.signal_observation_id = match?.id || null;
      }
    }

    const { data: persisted, error: persistError } = await supabase
      .from('actual_trade_lifecycles')
      .upsert(lifecycleRows, { onConflict: 'user_id,broker_account_id,broker_trade_id' })
      .select('id,user_id,broker_account_id,environment,engine,pair,direction,broker_trade_id,candidate_signal_id,signal_observation_id,closed_at,state,result,realized_r,mfe_r,mae_r,failure_reasons,entry_context');
    if (persistError) throw persistError;

    base.tradesUpserted = (persisted || []).length;
    base.closedTrades = (persisted || []).filter((row: JsonRecord) => row.state === 'closed').length;
    base.openTrades = (persisted || []).filter((row: JsonRecord) => row.state === 'open').length;
    base.unresolvedTrades = (persisted || []).filter((row: JsonRecord) => row.state === 'unresolved').length;
    base.wins = (persisted || []).filter((row: JsonRecord) => row.result === 'win').length;
    base.losses = (persisted || []).filter((row: JsonRecord) => row.result === 'loss').length;
    base.breakevens = (persisted || []).filter((row: JsonRecord) => row.result === 'breakeven').length;
    base.learningAdjustmentsApplied = await applyClosedTradeAudits((persisted || []) as JsonRecord[], now);
    return base;
  } catch (error) {
    return { ...base, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
