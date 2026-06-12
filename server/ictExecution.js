/**
 * server/ictExecution.js
 *
 * ICT Engine — MANUAL trade execution, isolated from V3. It never auto-trades
 * and is OFF by default (requires ICT_ENGINE_MODE=live AND ICT_AUTO_TRADE_ENABLED=true,
 * plus the broker-level live-ack FOREX_ALLOW_LIVE_EXECUTION).
 *
 * Reuses the EXISTING secure machinery without modifying V3 behavior:
 *   - the per-request OANDA client's order POST (same atomic MARKET + SL/TP-onFill
 *     mechanism as executeTrade) — `client.post('/v3/accounts/{id}/orders', …)`
 *   - the V3 live-ack guard `isLiveExecutionExplicitlyAllowed()`
 *   - the SHARED duplicate-lock registry (`reconcileTradeLock` + additive `registerTradeLock`)
 *   - `computeFixedDollarSizing` (correct pip-value / quote-currency / margin)
 *
 * The server is AUTHORITATIVE: it recomputes the ICT signal at execution and
 * sizes the position itself — client-supplied confidence/rr/units are never trusted.
 *
 *   executeIctTrade({ pair, direction, units, entry, stopLoss, targetProfit, ictSignalId },
 *                   { client, now, cfg, getAnalysis, getAccount, reconcile })
 */

import { getPipSize } from './pipMath.js';
import { isLiveExecutionExplicitlyAllowed, getAccountId } from './oandaClient.js';
import { reconcileTradeLock, registerTradeLock } from './oandaTrade.js';
import { computeFixedDollarSizing } from './oandaRiskSizing.js';
import { getAccountSummary, getCandles, getOpenTrades } from './oandaMarketData.js';
import {
  capPerTradeRiskPercent,
  checkMargin,
  checkRiskPerTrade,
  checkDailyRiskLock,
  checkAutoExecutionConfidence,
  clampUnitsToRiskBudget,
  validateStopLoss,
  checkConservativeCorrelatedExposure,
  computeOpenRiskUSD,
  evaluateNewTradeBudget,
  checkTpProbability,
  logPreSubmit,
  recordRejection,
  hydrateDailyBaseline,
  persistDailyState,
} from './riskManager.js';
import { analyzeICTPair, ictExecConfig } from './ictEngine.js';
import { getNewsRisk } from './news/forexFactoryNews.js';
import { estimateHoldMinutes } from './ictLifecycleEngine.js';

const PAIR_RE = /^[A-Z]{3}_[A-Z]{3}$/;
const isMetal = (p) => p === 'XAU_USD' || p === 'XAG_USD';
const priceDecimalsFor = (p) => (isMetal(p) ? 2 : String(p).includes('JPY') ? 3 : 5);

function blocked(reason, extra = {}) {
  return { success: false, blocked: true, executionState: 'BLOCKED', reason, ...extra };
}

// Default authoritative recompute: fetch fresh candles and run the ICT engine.
const ICT_TF = [
  ['monthly', 'M', 6], ['weekly', 'W', 12], ['daily', 'D', 60],
  ['h4', 'H4', 60], ['h1', 'H1', 120], ['m15', 'M15', 160], ['m5', 'M5', 120],
];
async function defaultGetAnalysis(pair, { client, now }) {
  const sets = await Promise.all(ICT_TF.map(([, g, n]) => getCandles(pair, g, n, { client }).catch(() => [])));
  const candles = {};
  ICT_TF.forEach(([k], i) => { candles[k] = sets[i]; });
  return analyzeICTPair({ pair, candles, peers: {}, now });
}

export async function executeIctTrade(params = {}, {
  client = null,
  now = new Date(),
  cfg = null,
  getAnalysis = null,
  getAccount = null,
  reconcile = null,
  getNews = null,
  autoAi = false,
  getOpen = null,
} = {}) {
  const config = cfg || ictExecConfig();
  const { pair, direction, entry, stopLoss, targetProfit, ictSignalId } = params;
  // Resolve the trading environment: signal override → per-request client → live.
  const tradingEnv = String(params.environment || client?.environment || 'live').toLowerCase();
  const isPaperEnv = tradingEnv === 'practice' || tradingEnv === 'paper';
  const log = [];
  const rec = (m) => { log.push(m); console.log(`[ICT_TRADE] ${m}`); };
  rec(`requested pair=${pair} dir=${direction} entry=${entry} sl=${stopLoss} tp=${targetProfit} id=${ictSignalId} env=${tradingEnv}`);

  // ── 1. Execution enabled (mode=live AND auto-trade) — the default-off gate ──
  if (!(config.mode === 'live' && config.autoTradeEnabled === true)) {
    return blocked(`ICT execution disabled (ICT_ENGINE_MODE=${config.mode}, ICT_AUTO_TRADE_ENABLED=${config.autoTradeEnabled}).`);
  }
  // ── 2. Live acknowledgement (LIVE only — paper/practice never requires it) ──
  if (!isPaperEnv && !isLiveExecutionExplicitlyAllowed()) {
    return blocked('Live execution not acknowledged (FOREX_ALLOW_LIVE_EXECUTION != true).');
  }
  // ── 3. Input sanity ────────────────────────────────────────────────────────
  if (typeof pair !== 'string' || !(PAIR_RE.test(pair) || isMetal(pair))) return blocked('Invalid pair.');
  if (direction !== 'long' && direction !== 'short') return blocked('Invalid direction (must be long or short).');
  if (![entry, stopLoss, targetProfit].every(Number.isFinite)) return blocked('entry/stopLoss/targetProfit must be finite numbers.');
  const geometryOK = direction === 'long'
    ? (stopLoss < entry && targetProfit > entry)
    : (stopLoss > entry && targetProfit < entry);
  if (!geometryOK) return blocked(`Invalid SL/TP geometry for ${direction}.`);

  // ── 4. Recompute ICT signal (server is authoritative) ──────────────────────
  const analyze = getAnalysis || ((p) => defaultGetAnalysis(p, { client, now }));
  let analysis;
  try { analysis = await analyze(pair); } catch (err) { return blocked(`ICT recompute failed: ${err.message}`); }
  const wantSignal = direction === 'long' ? 'buy' : 'sell';
  if (!analysis || analysis.signal !== wantSignal) {
    return blocked(`No current ICT ${wantSignal} signal for ${pair} (got "${analysis?.signal ?? 'none'}").`);
  }
  if (!(analysis.confidence >= config.minConfidence)) {
    return blocked(`ICT confidence below auto-trade threshold (${analysis.confidence} < ${config.minConfidence}).`);
  }
  if (!(Number.isFinite(analysis.rr) && analysis.rr >= config.minRR)) {
    return blocked(`RR ${analysis.rr} < ICT_MIN_RR ${config.minRR}.`);
  }
  // NOTE: the auto-execution confidence FLOOR (90, or 95 in conservative mode)
  // is enforced after the account is fetched (it needs the daily P&L state).

  // ── 4b. ForexFactory news risk — block within a high-impact window ─────────
  const news = getNews ? getNews({ pair, now }) : getNewsRisk({ pair, now });
  if (news?.blocked) {
    return blocked(news.blockReason || 'High-impact news window active.');
  }

  // ── 5. Staleness (signal id carries the generation timestamp) ──────────────
  const idMs = Number(String(ictSignalId ?? '').split(':').pop());
  const ageSec = Number.isFinite(idMs) ? (now.getTime() - idMs) / 1000 : NaN;
  if (!Number.isFinite(ageSec) || ageSec < -5 || ageSec > config.signalTtlSec) {
    return blocked(`Stale or invalid signal id (age ${Number.isFinite(ageSec) ? ageSec.toFixed(0) : '?'}s vs TTL ${config.signalTtlSec}s).`);
  }

  // ── 6. Credentials / per-user client ───────────────────────────────────────
  if (!client) return blocked('Missing per-user OANDA client — credentials not ready.');

  // ── 7. Duplicate protection (shared lock with V3) ──────────────────────────
  const reconcileFn = reconcile || (() => reconcileTradeLock(pair, direction, { client }));
  let dup;
  try { dup = await reconcileFn(); } catch (err) { return blocked(`Duplicate-lock check failed: ${err.message}`); }
  if (dup) return blocked(`Duplicate trade already active: ${pair}_${direction}`);

  // ── 8. Account + server-authoritative sizing (ICT_MAX_RISK_PERCENT) ────────
  const accountFn = getAccount || (() => getAccountSummary({ client }));
  let account;
  try { account = await accountFn(); } catch (err) { return blocked(`Failed to fetch account: ${err.message}`); }
  const balanceUSD = parseFloat(account?.balance ?? 0);
  if (!balanceUSD || Number.isNaN(balanceUSD)) return blocked('Account balance is 0 — fund account before live trading.');

  // Records the most recent risk rejection for the dashboard, then blocks.
  const denyRisk = (reason) => {
    recordRejection({ accountId: client.accountId, reason, engine: 'ICT' });
    rec(`blocked: ${reason}`);
    return blocked(reason);
  };

  // ── 8a. Daily drawdown circuit breaker (blocks NEW entries, central) ───────
  // Hydrate the durable baseline first so a mid-day restart never re-anchors the
  // day's starting balance to the current (lower) balance.
  await hydrateDailyBaseline({ accountId: client.accountId, balanceUSD, now });
  const dailyLock = checkDailyRiskLock({ accountId: client.accountId, balanceUSD, now });
  await persistDailyState({ accountId: client.accountId, status: dailyLock, now });
  if (dailyLock.tradingLocked) {
    return denyRisk(dailyLock.reason);
  }

  // ── 8a-ii. Auto-execution confidence floor (95% across all auto engines) ────
  if (autoAi) {
    const confCheck = checkAutoExecutionConfidence(analysis.confidence, { accountId: client.accountId, balanceUSD, now });
    if (!confCheck.passed) return denyRisk(confCheck.reason);
  }

  // ── 8a-iii. Account-as-one-risk-system: open risk + daily budget gate ──────
  let openTrades = [];
  try {
    const openFn = getOpen || (() => getOpenTrades({ client }));
    openTrades = (await openFn()) || [];
  } catch (err) {
    rec(`open-trades fetch failed — ${err.message}`);
  }
  const openTradeRiskUSD = computeOpenRiskUSD(openTrades);
  const budget = evaluateNewTradeBudget({ accountId: client.accountId, balanceUSD, openTradeRiskUSD, now });
  if (!budget.passed) return denyRisk(budget.reason);

  const pipSize = getPipSize(pair);
  const slPips = +(Math.abs(entry - stopLoss) / pipSize).toFixed(1);
  const tpPips = +(Math.abs(targetProfit - entry) / pipSize).toFixed(1);

  // ── Stop-loss validation — never submit a trade without an enforceable stop ─
  {
    const slCheck = validateStopLoss({ entry, stopLoss, direction, stopLossPips: slPips });
    if (!slCheck.valid) return denyRisk(slCheck.reason);
  }

  // Per-trade cap (1.4%) AND the remaining daily budget — whichever is smaller.
  const effectiveRiskPercent = capPerTradeRiskPercent(config.maxRiskPercent);
  const targetRiskUSD = +Math.min(balanceUSD * (effectiveRiskPercent / 100), budget.allowedNewTradeRisk).toFixed(2);
  const sizing = computeFixedDollarSizing({
    pair, direction, entryPrice: entry, targetRiskUSD,
    stopLossPips: slPips, stopLossPrice: stopLoss,
    takeProfitPips: tpPips, takeProfitPrice: targetProfit,
    accountMarginRate: parseFloat(account?.marginRate ?? 0),
    accountBalanceUSD: balanceUSD,
  });
  let units = sizing.signedUnits;
  let absUnits = Math.abs(units);
  let estimatedMargin = sizing.estimatedMarginRequired;
  let actualRiskUSD = sizing.actualRiskUSD;
  if (!absUnits || absUnits < 1) {
    return denyRisk(`Sizing produced 0 units for $${targetRiskUSD} risk at ${slPips}p stop.`);
  }

  // ── Hard unit clamp to the per-trade risk budget — reduce, or reject if it
  //    can't be sized safely. Bulletproofs the cap regardless of sizing inputs.
  {
    const riskPerUnitUSD = absUnits > 0 ? actualRiskUSD / absUnits : 0;
    const clamp = clampUnitsToRiskBudget({ balanceUSD, requestedUnits: absUnits, riskPerUnitUSD });
    if (!clamp.ok) return denyRisk(clamp.reason);
    if (clamp.reduced) {
      const scale = clamp.units / absUnits;
      estimatedMargin = +(estimatedMargin * scale).toFixed(2);
      absUnits = clamp.units;
      units = direction === 'short' ? -absUnits : absUnits;
      actualRiskUSD = clamp.riskUSD;
      rec(`risk clamp — units reduced to ${absUnits} (risk now $${actualRiskUSD.toFixed(2)})`);
    }
  }

  // ── 8b. Margin guard — never place a trade we cannot afford the margin for ──
  const marginAvailable = parseFloat(account?.marginAvailable ?? 0);
  const marginCheck = checkMargin({ marginAvailable, estimatedMargin });
  if (!marginCheck.allowed) {
    return denyRisk(marginCheck.reason);
  }

  // ── 8b-ii. Hard risk-per-trade validation (actual sized risk ≤ 1.4%) ───────
  const riskCheck = checkRiskPerTrade({
    balanceUSD, actualDollarRisk: actualRiskUSD, stopLossPips: slPips, positionSize: absUnits,
  });
  if (!riskCheck.passed) {
    return denyRisk(riskCheck.reason);
  }

  // ── 8c. Projected daily risk must stay under the 2.8% cap (realized+open+new) ─
  {
    const realizedLoss = Math.abs(Math.min(budget.realizedPnL, 0));
    const projectedDailyRisk = +(realizedLoss + budget.openTradeRisk + actualRiskUSD).toFixed(2);
    if (projectedDailyRisk > budget.dailyLossLimit + 1e-9) {
      return denyRisk(
        `Projected daily risk $${projectedDailyRisk.toFixed(2)} would exceed the daily cap ` +
        `$${budget.dailyLossLimit.toFixed(2)} — trade rejected.`,
      );
    }
  }

  // ── 8d. Auto quality gates: TP probability + conservative correlated exposure ─
  if (autoAi) {
    const tp = checkTpProbability({
      stopLossPips: slPips, takeProfitPips: tpPips,
      atrPips: analysis.atrPips ?? analysis.concepts?.atrPips ?? null, spreadPips: analysis.spreadPips ?? null,
    });
    rec(
      `[TRADE QUALITY CHECK] engine=ICT pair=${pair} direction=${direction} confidence=${analysis.confidence} ` +
      `setup=${analysis.setupType ?? 'n/a'} tpProbability=${tp.passed ? 'ok' : 'low'} passed=${tp.passed}` +
      `${tp.passed ? '' : ` rejectionReason=${tp.reason}`}`,
    );
    if (!tp.passed) return denyRisk(tp.reason);

    const corr = checkConservativeCorrelatedExposure({
      conservativeMode: dailyLock.conservativeMode, pair, direction, openTrades,
    });
    if (!corr.allowed) return denyRisk(corr.reason);
  }

  // ── 9. Place the order through the EXISTING OANDA client (atomic MARKET) ────
  const accountId = client.accountId || getAccountId();
  const dp = priceDecimalsFor(pair);
  const orderPayload = {
    order: {
      type: 'MARKET', instrument: pair, units: units.toString(),
      timeInForce: 'IOC', positionFill: 'DEFAULT',
      stopLossOnFill: { price: stopLoss.toFixed(dp), timeInForce: 'GTC' },
      takeProfitOnFill: { price: targetProfit.toFixed(dp), timeInForce: 'GTC' },
    },
  };
  logPreSubmit({
    engine: 'ICT',
    mode: `${autoAi ? 'auto' : 'manual'}${dailyLock.conservativeMode ? '+conservative' : ''}`,
    balanceUSD,
    stopLossPips: slPips,
    units,
    actualDollarRisk: actualRiskUSD,
    riskPercent: +((actualRiskUSD / balanceUSD) * 100).toFixed(3),
  });
  rec(`submitted ${pair} ${direction} units=${units} risk=$${actualRiskUSD.toFixed(2)} (recomputed conf=${analysis.confidence} rr=${analysis.rr})`);

  let resp;
  try {
    resp = await client.post(`/v3/accounts/${accountId}/orders`, orderPayload);
  } catch (err) {
    rec(`rejected: submit error ${err.message}`);
    return { success: false, blocked: false, executionState: 'REJECTED', reason: `Order submission failed: ${err.message}`, sizing, executionLog: log };
  }

  if (resp?.orderCancelTransaction) {
    const reason = resp.orderCancelTransaction.reason || 'UNKNOWN';
    rec(`rejected: cancelled by OANDA (${reason})`);
    return { success: false, blocked: false, executionState: 'CANCELLED', reason: `Order cancelled by OANDA: ${reason}`, sizing, oandaResponse: resp, executionLog: log };
  }
  const fill = resp?.orderFillTransaction;
  if (!fill) {
    rec('rejected: no fill transaction (IOC found no liquidity)');
    return { success: false, blocked: false, executionState: 'REJECTED', reason: 'No fill transaction — IOC order found no liquidity.', sizing, oandaResponse: resp, executionLog: log };
  }

  // Filled — SL/TP attached atomically on fill. Register the shared lock.
  registerTradeLock(pair, direction);
  const tradeId = fill.tradeOpened?.tradeID || fill.id || fill.tradeID || null;
  const fillPrice = parseFloat(fill.price ?? entry);
  // Projected hold-time for the ICT lifecycle reassessment (recorded at open).
  const holdMinutes = estimateHoldMinutes(analysis.setupType, analysis.concepts?.killzone);
  rec(`filled tradeId=${tradeId} price=${fillPrice} units=${units} holdMinutes=${holdMinutes}`);
  return {
    success: true, blocked: false, executionState: 'FILLED',
    tradeId, fillPrice, units, pair, direction,
    stopLoss, takeProfit: targetProfit,
    riskUSD: actualRiskUSD, signalId: analysis.signalId,
    holdMinutes,
    executionLog: log,
  };
}
