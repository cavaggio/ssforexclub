const ENGINES = new Set(['ict', 'ppr', 'v3']);
import { classifyIctTradeFailure } from '../../server/ictTradeContext.js';

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function deepFind(opening, keys) {
  const queue = [object(opening?.raw_payload), object(opening)];
  const visited = new Set();
  let inspected = 0;
  while (queue.length && inspected < 750) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);
    inspected += 1;
    for (const key of keys) {
      if (current[key] !== undefined && current[key] !== null && current[key] !== '') return current[key];
    }
    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}

/**
 * @param {{
 *   pair?: unknown,
 *   direction?: unknown,
 *   entryPrice?: unknown,
 *   stopLoss?: unknown,
 *   candles?: Array<Record<string, any>>
 * }} [options]
 */
export function computeTradeExcursion({ pair, direction, entryPrice, stopLoss, candles = [] } = {}) {
  const side = normalizeDirection(direction);
  const entry = numeric(entryPrice);
  const stop = numeric(stopLoss);
  if (!side || entry === null || stop === null || !Array.isArray(candles) || !candles.length) {
    return { mfePips: null, maePips: null, mfeR: null, maeR: null };
  }
  const highs = candles.map((candle) => numeric(candle?.high ?? candle?.mid?.h)).filter((value) => value !== null);
  const lows = candles.map((candle) => numeric(candle?.low ?? candle?.mid?.l)).filter((value) => value !== null);
  if (!highs.length || !lows.length) return { mfePips: null, maePips: null, mfeR: null, maeR: null };
  const high = Math.max(...highs);
  const low = Math.min(...lows);
  const favorable = side === 'long' ? high - entry : entry - low;
  const adverse = side === 'long' ? entry - low : high - entry;
  const risk = Math.abs(entry - stop);
  const pip = String(pair || '').includes('JPY') ? 0.01 : 0.0001;
  return {
    mfePips: +(Math.max(0, favorable) / pip).toFixed(3),
    maePips: +(Math.max(0, adverse) / pip).toFixed(3),
    mfeR: risk > 0 ? +(Math.max(0, favorable) / risk).toFixed(6) : null,
    maeR: risk > 0 ? +(-Math.max(0, adverse) / risk).toFixed(6) : null,
  };
}

/**
 * @param {{
 *   trade?: Record<string, any>,
 *   closingTransactions?: Array<Record<string, any>>
 * }} [options]
 */
export function inferBrokerExitReason({ trade = {}, closingTransactions = [] } = {}) {
  for (const transaction of Array.isArray(closingTransactions) ? closingTransactions : []) {
    const reason = text(transaction?.reason || transaction?.type);
    if (reason) return reason.toLowerCase();
  }
  return text(trade.closeReason || trade.reason) || (String(trade.state || '').toUpperCase() === 'CLOSED' ? 'broker_trade_closed' : null);
}

function auditIdFromOpening(opening = {}) {
  const raw = object(opening.raw_payload);
  const validAuditId = (value) => {
    const candidate = text(value);
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate || '')
      ? candidate
      : null;
  };
  const queue = [raw];
  const visited = new Set();
  let inspected = 0;
  while (queue.length && inspected < 500) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);
    inspected += 1;
    const direct = validAuditId(current.learningAuditId) ||
      validAuditId(object(current.combinedLearningContext).auditId);
    if (direct) return direct;
    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}

export function normalizeEngine(value) {
  const engine = String(value || '').trim().toLowerCase();
  return ENGINES.has(engine) ? engine : null;
}

export function normalizePair(value) {
  const pair = String(value || '').trim().replace('/', '_').toUpperCase();
  return /^[A-Z]{3}_[A-Z]{3}$/.test(pair) ? pair : null;
}

export function normalizeDirection(value) {
  const direction = String(value || '').trim().toLowerCase();
  if (['long', 'buy', 'bullish'].includes(direction)) return 'long';
  if (['short', 'sell', 'bearish'].includes(direction)) return 'short';
  return null;
}

export function classifyActualResult(state, realizedPl) {
  if (String(state || '').toUpperCase() !== 'CLOSED') return 'open';
  const pnl = numeric(realizedPl);
  if (pnl === null || Math.abs(pnl) < 0.0000001) return 'breakeven';
  return pnl > 0 ? 'win' : 'loss';
}

export function computeActualRealizedR({ direction, entryPrice, exitPrice, stopLoss, realizedPl, riskUsd }) {
  const pnl = numeric(realizedPl);
  const plannedRiskUsd = numeric(riskUsd);
  if (pnl !== null && plannedRiskUsd !== null && plannedRiskUsd > 0) {
    return Number((pnl / plannedRiskUsd).toFixed(6));
  }

  const side = normalizeDirection(direction);
  const entry = numeric(entryPrice);
  const exit = numeric(exitPrice);
  const stop = numeric(stopLoss);
  if (!side || entry === null || exit === null || stop === null) return null;
  const riskDistance = Math.abs(entry - stop);
  if (!(riskDistance > 0)) return null;
  const value = side === 'long' ? (exit - entry) / riskDistance : (entry - exit) / riskDistance;
  return Number(value.toFixed(6));
}

/**
 * @param {{
 *   opening?: Record<string, any>,
 *   trade?: Record<string, any>,
 *   closingTransactions?: Array<Record<string, any>>,
 *   excursion?: Record<string, any> | null,
 *   reconciledAt?: Date | string | number
 * }} [options]
 */
export function buildActualTradeLifecycleRow({ opening = {}, trade = {}, closingTransactions = [], excursion = null, reconciledAt = new Date() } = {}) {
  const engine = normalizeEngine(opening.engine);
  const brokerAccountId = text(opening.broker_account_id);
  const brokerTradeId = text(opening.broker_trade_id || trade.id);
  const userId = text(opening.user_id);
  if (!engine || !brokerAccountId || !brokerTradeId || !userId) {
    throw new Error('Actual trade lifecycle attribution requires user, broker account, engine, and broker trade ID.');
  }

  const pair = normalizePair(trade.instrument || opening.pair);
  const direction = normalizeDirection(opening.direction || (numeric(trade.initialUnits) >= 0 ? 'long' : 'short'));
  const entryPrice = numeric(trade.price ?? opening.entry_price);
  const exitPrice = numeric(trade.averageClosePrice ?? opening.exit_price);
  const stopLoss = numeric(trade.stopLossOrder?.price ?? opening.stop_loss);
  const takeProfit = numeric(trade.takeProfitOrder?.price ?? opening.take_profit);
  const realizedPl = numeric(trade.realizedPL ?? opening.realized_pl);
  const riskUsd = numeric(opening.risk_usd);
  const state = String(trade.state || opening.state || 'OPEN').toUpperCase();
  const result = classifyActualResult(state, realizedPl);
  const realizedR = computeActualRealizedR({
    direction,
    entryPrice,
    exitPrice,
    stopLoss,
    realizedPl,
    riskUsd,
  });
  const entryContext = object(deepFind(opening, ['entryContext']));
  const candidateSignalId = text(
    entryContext.candidateSignalId || deepFind(opening, ['candidateSignalId', 'signalId', 'ictSignalId']),
  );
  const exitReason = inferBrokerExitReason({ trade, closingTransactions });
  const measured = excursion && typeof excursion === 'object' ? excursion : {};
  const failure = classifyIctTradeFailure({
    entryContext,
    realizedR,
    mfeR: measured.mfeR,
    maeR: measured.maeR,
    exitReason,
  });

  return {
    user_id: userId,
    broker_account_id: brokerAccountId,
    environment: text(opening.environment) || 'unknown',
    broker: 'oanda',
    engine,
    broker_trade_id: brokerTradeId,
    candidate_signal_id: candidateSignalId,
    learning_audit_id: auditIdFromOpening(opening),
    source_trade_log_id: text(opening.trade_log_id),
    pair,
    direction,
    opened_at: text(trade.openTime || opening.opened_at),
    closed_at: state === 'CLOSED' ? text(trade.closeTime || opening.closed_at) : null,
    state: state === 'CLOSED' ? 'closed' : 'open',
    result,
    entry_price: entryPrice,
    exit_price: exitPrice,
    units: numeric(trade.initialUnits ?? opening.units),
    stop_loss: stopLoss,
    take_profit: takeProfit,
    risk_usd: riskUsd,
    realized_pl: realizedPl,
    realized_r: realizedR,
    entry_context: entryContext,
    d1_state: text(entryContext.timeframeState?.d1),
    h4_state: text(entryContext.timeframeState?.h4),
    h1_state: text(entryContext.timeframeState?.h1Structure),
    h1_momentum: object(entryContext.h1Momentum),
    m5_authorization: object(entryContext.m5Authorization),
    m5_trigger_age_bars: numeric(entryContext.m5Authorization?.triggerAgeBars),
    po3_stage: text(entryContext.powerOfThree?.stage),
    htf_liquidity_condition: object(entryContext.htfLiquidityCondition),
    exit_reason: state === 'CLOSED' ? failure.exitReason : null,
    mfe_pips: numeric(measured.mfePips),
    mae_pips: numeric(measured.maePips),
    mfe_r: numeric(measured.mfeR),
    mae_r: numeric(measured.maeR),
    failure_reasons: state === 'CLOSED' ? failure.failureReasons : [],
    learning_adjustment: state === 'CLOSED' ? failure.adjustment : null,
    opening_transaction_ids: Array.isArray(trade.openingTransactionIDs)
      ? trade.openingTransactionIDs.map(String)
      : [],
    closing_transaction_ids: Array.isArray(trade.closingTransactionIDs)
      ? trade.closingTransactionIDs.map(String)
      : [],
    engine_attribution_source: 'trade_log_open',
    actual_outcome_source: state === 'CLOSED' ? 'oanda_trade_detail' : 'oanda_open_trade_detail',
    opening_snapshot: opening.raw_payload && typeof opening.raw_payload === 'object' ? opening.raw_payload : {},
    broker_snapshot: trade && typeof trade === 'object' ? trade : {},
    reconciled_at: reconciledAt instanceof Date ? reconciledAt.toISOString() : new Date(reconciledAt).toISOString(),
    updated_at: reconciledAt instanceof Date ? reconciledAt.toISOString() : new Date(reconciledAt).toISOString(),
  };
}
