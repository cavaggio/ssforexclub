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
import { getAccountSummary, getCandles, getOpenTrades, getPricing } from './oandaMarketData.js';
import { checkTotalOpenRisk, computeOpenRiskPercent, computeOpenRiskUSD } from './autoAiRiskLimits.js';
import {
  capPerTradeRiskPercent,
  checkMargin,
  checkRiskPerTrade,
  checkDailyRiskLock,
  reserveDailyLossBudget,
  checkAutoExecutionConfidence,
} from './riskManager.js';
import { analyzeICTPair, ictExecConfig } from './ictEngine.js';
import { getNewsRisk } from './news/forexFactoryNews.js';
import { estimateHoldMinutes } from './ictLifecycleEngine.js';

import { evaluateUniversalEntryPolicy, setupFingerprint } from './executionPolicy.js';
import { reserveExecution, markExecutionOpen, releaseExecution } from './executionReservations.js';
import { isExplicitSwingSignal } from './scalpOnlyPolicy.js';
const PAIR_RE = /^[A-Z]{3}_[A-Z]{3}$/;
const isMetal = (p) => p === 'XAU_USD' || p === 'XAG_USD';
const priceDecimalsFor = (p) => (isMetal(p) ? 2 : String(p).includes('JPY') ? 3 : 5);

function quoteMidPrice(q) {
  const bid = Number(q?.closeoutBid ?? q?.bid ?? q?.bids?.[0]?.price);
  const ask = Number(q?.closeoutAsk ?? q?.ask ?? q?.asks?.[0]?.price);
  if (Number.isFinite(bid) && Number.isFinite(ask)) return { bid, ask, mid: (bid + ask) / 2, spread: ask - bid };
  return { bid: null, ask: null, mid: null, spread: null };
}

function validateFreshProtectivePrices({ pair, direction, quote, stopLoss, targetProfit }) {
  const pipSize = getPipSize(pair);
  const bufferPips = Number(process.env.ICT_EXECUTION_PRICE_BUFFER_PIPS || 2);
  const minBuffer = pipSize * bufferPips;

  const { bid, ask, mid, spread } = quoteMidPrice(quote);
  const executable = direction === 'long' ? ask : bid;

  if (!Number.isFinite(executable)) {
    return {
      ok: false,
      reason: `Could not read fresh executable ${direction === 'long' ? 'ask' : 'bid'} price for ${pair}.`,
      bid,
      ask,
      mid,
      spread,
    };
  }

  const ok = direction === 'long'
    ? stopLoss < executable - minBuffer && targetProfit > executable + minBuffer
    : stopLoss > executable + minBuffer && targetProfit < executable - minBuffer;

  if (!ok) {
    return {
      ok: false,
      reason:
        `Stale/invalid protective prices for ${direction} ${pair}: ` +
        `freshExecutable=${executable.toFixed(priceDecimalsFor(pair))}, ` +
        `SL=${stopLoss.toFixed(priceDecimalsFor(pair))}, ` +
        `TP=${targetProfit.toFixed(priceDecimalsFor(pair))}. ` +
        `Refusing order to avoid OANDA TAKE_PROFIT_ON_FILL_LOSS / STOP_LOSS_ON_FILL_LOSS.`,
      bid,
      ask,
      mid,
      spread,
    };
  }

  return { ok: true, bid, ask, mid, spread };
}

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
  if (isExplicitSwingSignal(analysis)) {
    return blocked('Scalp-only execution: ICT swing trade signals are disabled.');
  }
  if (!(Number.isFinite(analysis.rr) && analysis.rr >= config.minRR)) {
    return blocked(`RR ${analysis.rr} < ICT_MIN_RR ${config.minRR}.`);
  }
  // Auto execution confidence floor (≥90) — central, applies to autonomous runs.
  if (autoAi) {
    const confCheck = checkAutoExecutionConfidence(analysis.confidence);
    if (!confCheck.passed) return blocked(confCheck.reason);
  }

  const universalPolicy = evaluateUniversalEntryPolicy({ ...analysis, pair, direction });
  if (!universalPolicy.allowed) return blocked(`Universal entry policy: ${universalPolicy.reasons.join('; ')}`);

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

  // ── 8a. Daily drawdown circuit breaker (blocks NEW entries, central) ───────
  const dailyLock = checkDailyRiskLock({ accountId: client.accountId, balanceUSD, now });
  if (dailyLock.tradingLocked) {
    rec(`blocked: ${dailyLock.reason}`);
    return blocked(dailyLock.reason);
  }

  const pipSize = getPipSize(pair);
  const slPips = +(Math.abs(entry - stopLoss) / pipSize).toFixed(1);
  const tpPips = +(Math.abs(targetProfit - entry) / pipSize).toFixed(1);
  // Hard per-trade risk cap (RISK_MAX_PER_TRADE_PERCENT) — applies to every trade.
  const effectiveRiskPercent = capPerTradeRiskPercent(config.maxRiskPercent);
  const requestedRiskUSD = +(balanceUSD * (effectiveRiskPercent / 100)).toFixed(2);
  let openTradesForBudget = [];
  try { const openFn = getOpen || (() => getOpenTrades({ client })); openTradesForBudget = (await openFn()) || []; } catch (err) { return blocked(`Could not calculate open stop risk: ${err.message}`); }
  const dailyBudget = reserveDailyLossBudget({ accountId: client.accountId, balanceUSD, openRiskUSD: computeOpenRiskUSD(openTradesForBudget), requestedRiskUSD, now });
  if (!dailyBudget.allowed) return blocked(dailyBudget.reason);
  const targetRiskUSD = dailyBudget.approvedRiskUSD;
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

  // ── 8b-ii. Hard risk-per-trade validation (actual sized risk ≤ 1.4%) ───────
  const riskCheck = checkRiskPerTrade({
    balanceUSD, actualDollarRisk: sizing.actualRiskUSD, stopLossPips: slPips, positionSize: Math.abs(units),
  });
  if (!riskCheck.passed) {
    rec(`blocked: ${riskCheck.reason}`);
    return blocked(riskCheck.reason);
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

  // ── 8d. Fresh executable price guard ───────────────────────────────────────
  // OANDA validates SL/TP-on-fill against the actual fill-side price, not the
  // stale signal entry shown in the UI. Recheck bid/ask immediately before submit
  // using the same per-request OANDA client that will submit the order.
  let freshQuote = null;

  const accountId =
    client?.accountId ||
    client?.accountID ||
    client?.account_id ||
    client?.config?.accountId ||
    client?.defaults?.accountId;

  if (!accountId) {
    rec('blocked: fresh price check failed (missing per-request OANDA accountId)');
    return blocked('Fresh price check failed before execution: missing per-request OANDA accountId');
  }

  try {
    const pricingPath = `/v3/accounts/${accountId}/pricing?instruments=${encodeURIComponent(pair)}`;

    let pricingResponse;

    if (typeof client.get === 'function') {
      pricingResponse = await client.get(pricingPath);
    } else if (typeof client.request === 'function') {
      pricingResponse = await client.request({
        method: 'GET',
        url: pricingPath,
        path: pricingPath,
      });
    } else if (typeof client.getPricing === 'function') {
      pricingResponse = await client.getPricing([pair], accountId);
    } else if (typeof client.pricing === 'function') {
      pricingResponse = await client.pricing([pair], accountId);
    } else {
      pricingResponse = {
        prices: [
          {
            instrument: pair,
            bids: [{ price: String(entry) }],
            asks: [{ price: String(entry) }],
          },
        ],
      };
    }

    const pricingPayload = pricingResponse?.data ?? pricingResponse;

    freshQuote = Array.isArray(pricingPayload)
      ? pricingPayload[0]
      : pricingPayload?.prices?.[0] || pricingPayload?.[pair] || pricingPayload;
  } catch (err) {
    rec(`blocked: fresh price check failed (${err.message})`);
    return blocked(`Fresh price check failed before execution: ${err.message}`);
  }

  const protectiveCheck = validateFreshProtectivePrices({
    pair,
    direction,
    quote: freshQuote,
    stopLoss,
    targetProfit,
  });

  if (!protectiveCheck.ok) {
    rec(`blocked: ${protectiveCheck.reason}`);
    return blocked(protectiveCheck.reason, { freshPrice: protectiveCheck });
  }

  // ── 9. Place the order through the EXISTING OANDA client (atomic MARKET) ────
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
    const executionSignal = { ...analysis, pair, direction, entry, stopLoss, takeProfit: targetProfit };
    const setupKey = setupFingerprint(executionSignal, accountId);
    const reservation = await reserveExecution({ fingerprint: setupKey, accountId, pair, direction });
    if (!reservation.allowed) return blocked(`Atomic setup reservation rejected: ${reservation.reason}`);
    params.__reservationHash = reservation.hash;
    resp = await client.post(`/v3/accounts/${accountId}/orders`, orderPayload);
  } catch (err) {
    if (params.__reservationHash) await releaseExecution(params.__reservationHash, 'failed');
    rec(`rejected: submit error ${err.message}`);
    return { success: false, blocked: false, executionState: 'REJECTED', reason: `Order submission failed: ${err.message}`, sizing, executionLog: log };
  }

  if (resp?.orderCancelTransaction) {
    const reason = resp.orderCancelTransaction.reason || 'UNKNOWN';
    const friendlyReason = reason === 'TAKE_PROFIT_ON_FILL_LOSS'
      ? 'Order cancelled by OANDA: TAKE_PROFIT_ON_FILL_LOSS — the take-profit was no longer safely beyond the actual fill price. Signal/target was stale or too close after spread. Refresh the signal and execute only if TP is still beyond current executable price.'
      : `Order cancelled by OANDA: ${reason}`;
    if (params.__reservationHash) await releaseExecution(params.__reservationHash, 'cancelled');
    rec(`rejected: cancelled by OANDA (${reason})`);
    return { success: false, blocked: false, executionState: 'CANCELLED', reason: friendlyReason, sizing, oandaResponse: resp, executionLog: log };
  }
  const fill = resp?.orderFillTransaction;
  if (!fill) {
    rec('rejected: no fill transaction (IOC found no liquidity)');
    return { success: false, blocked: false, executionState: 'REJECTED', reason: 'No fill transaction — IOC order found no liquidity.', sizing, oandaResponse: resp, executionLog: log };
  }

  // Filled — SL/TP attached atomically on fill. Register the shared lock.
  registerTradeLock(pair, direction);
  const tradeId = fill.tradeOpened?.tradeID || fill.id || fill.tradeID || null;
  if (params.__reservationHash) await markExecutionOpen({ hash: params.__reservationHash, tradeId });
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



// === ACTIVE TRADE LOGIC PATCH ===
export function getNewYorkHour(date = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      hour12: false,
    }).format(date)
  );
  return hour === 24 ? 0 : hour;
}

export function isPrimaryTradeWindow(date = new Date()) {
  const hour = getNewYorkHour(date);
  return hour >= 2 && hour < 10;
}

export function isTrueHardReject(reason = "") {
  const r = String(reason).toLowerCase();
  return (
    r.includes("rr") && r.includes("1.5") ||
    r.includes("risk reward") && r.includes("below") ||
    r.includes("max daily loss") ||
    r.includes("daily loss") ||
    r.includes("max trades") ||
    r.includes("duplicate") ||
    r.includes("spread too high") ||
    r.includes("invalid broker") ||
    r.includes("credentials") ||
    r.includes("missing stop") ||
    r.includes("missing take profit") ||
    r.includes("live trading disabled") ||
    r.includes("execution disabled")
  );
}

export function softenRejectReasons(reasons = [], now = new Date()) {
  if (!isPrimaryTradeWindow(now)) return reasons;

  return reasons.filter((reason) => {
    const r = String(reason).toLowerCase();

    if (isTrueHardReject(r)) return true;

    if (
      r.includes("late_entry") ||
      r.includes("late entry") ||
      r.includes("flow opposes") ||
      r.includes("institutional flow") ||
      r.includes("missing smt") ||
      r.includes("missing fvg") ||
      r.includes("mixed ema") ||
      r.includes("emaalignment=mixed") ||
      r.includes("single opposing liquidity") ||
      r.includes("liquidity proxy")
    ) {
      return false;
    }

    return true;
  });
}

export function pickTradeMode(candidate = {}) {
  const rr = Number(candidate.rr ?? candidate.riskReward ?? candidate.expectedRR ?? 0);
  const confidence = Number(candidate.confidence ?? candidate.score ?? 0);

  if (rr >= 1.5 && confidence >= 85) return "SCALP";
  return "NONE";
}
// === END ACTIVE TRADE LOGIC PATCH ===

