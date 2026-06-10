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
  checkTotalOpenRisk,
  computeOpenRiskPercent,
} from './autoAiRiskLimits.js';
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

  const pipSize = getPipSize(pair);
  const slPips = +(Math.abs(entry - stopLoss) / pipSize).toFixed(1);
  const tpPips = +(Math.abs(targetProfit - entry) / pipSize).toFixed(1);
  // Auto AI caps per-trade risk at AUTO_AI_MAX_RISK_PER_TRADE_PERCENT (never above).
  const effectiveRiskPercent = autoAi ? capPerTradeRiskPercent(config.maxRiskPercent) : config.maxRiskPercent;
  const targetRiskUSD = +(balanceUSD * (effectiveRiskPercent / 100)).toFixed(2);
  const sizing = computeFixedDollarSizing({
    pair, direction, entryPrice: entry, targetRiskUSD,
    stopLossPips: slPips, stopLossPrice: stopLoss,
    takeProfitPips: tpPips, takeProfitPrice: targetProfit,
    accountMarginRate: parseFloat(account?.marginRate ?? 0),
    accountBalanceUSD: balanceUSD,
  });
  const units = sizing.signedUnits;
  if (!units || Math.abs(units) < 1) {
    return blocked(`Sizing produced 0 units for $${targetRiskUSD} risk at ${slPips}p stop.`);
  }

  // ── 8b. Margin guard — never place a trade we cannot afford the margin for ──
  const marginAvailable = parseFloat(account?.marginAvailable ?? 0);
  const marginCheck = checkMargin({ marginAvailable, estimatedMargin: sizing.estimatedMarginRequired });
  if (!marginCheck.allowed) {
    rec(`blocked: margin avail=$${marginAvailable} required=$${sizing.estimatedMarginRequired}`);
    return blocked(marginCheck.reason);
  }

  // ── 8c. Auto AI total-open-risk cap (AUTO_AI_MAX_TOTAL_OPEN_RISK_PERCENT) ──
  if (autoAi) {
    let openTrades = [];
    try {
      const openFn = getOpen || (() => getOpenTrades({ client }));
      openTrades = (await openFn()) || [];
    } catch (err) {
      rec(`open-risk check skipped — could not fetch open trades (${err.message})`);
    }
    const currentOpenRiskPercent = computeOpenRiskPercent(openTrades, balanceUSD) ?? 0;
    const newTradeRiskPercent = +((sizing.actualRiskUSD / balanceUSD) * 100).toFixed(4);
    const totalCheck = checkTotalOpenRisk(currentOpenRiskPercent, newTradeRiskPercent);
    if (!totalCheck.allowed) {
      rec(`blocked: ${totalCheck.reason}`);
      return blocked(totalCheck.reason);
    }
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
  rec(`submitted ${pair} ${direction} units=${units} risk=$${targetRiskUSD} (recomputed conf=${analysis.confidence} rr=${analysis.rr})`);

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
    riskUSD: sizing.actualRiskUSD, signalId: analysis.signalId,
    holdMinutes,
    executionLog: log,
  };
}
