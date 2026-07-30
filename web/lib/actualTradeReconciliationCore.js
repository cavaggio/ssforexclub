const ENGINES = new Set(['ict', 'ppr', 'v3']);

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
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

export function buildActualTradeLifecycleRow({ opening = {}, trade = {}, reconciledAt = new Date() } = {}) {
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

  return {
    user_id: userId,
    broker_account_id: brokerAccountId,
    environment: text(opening.environment) || 'unknown',
    broker: 'oanda',
    engine,
    broker_trade_id: brokerTradeId,
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
