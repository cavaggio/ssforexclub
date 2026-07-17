/**
 * server/oandaTrade.js
 * Executes forex and metals trades through OANDA v20 REST API.
 *
 * Atomic execution (single round-trip):
 *   - Single MARKET (IOC) order with `stopLossOnFill` + `takeProfitOnFill` attached.
 *   - SL/TP are bound to the initial order — if the order fills, SL/TP are
 *     guaranteed to attach on the same fill transaction.
 *   - If OANDA cancels (e.g. STOP_LOSS_ON_FILL_LOSS, INSUFFICIENT_MARGIN), the
 *     entire request is rejected — no orphaned positions.
 *
 * Position sizing comes from the temporary fixed-dollar risk module:
 *   ~$50 risk / ~$100+ reward, 10–20 pip stop, 2R+ TP. Qualification, scoring,
 *   spread/session filters, and duplicate protection are NOT modified here.
 *
 * Pre-trade margin check: rejects if projected free margin < 25% of balance.
 */

import { getAccountId, oandaPost, oandaPut, getEnvironment, isLiveExecutionExplicitlyAllowed } from './oandaClient.js';
import { getAccountSummary, getOpenTrades,
  getPricing
} from './oandaMarketData.js';
import { recordTrade } from './oandaTradeHistory.js';
import {
  RISK_MODE,
  MIN_RISK_PERCENT,
  MAX_RISK_PERCENT,
  DYNAMIC_RISK_NOTICE,
  computeFixedDollarSizing,
  computeDynamicTradeRisk,
} from './oandaRiskSizing.js';
import { computeTradeLifecycle } from './oandaTradeLifecycle.js';
import { getCandles } from './oandaMarketData.js';
import { checkTotalOpenRisk, computeOpenRiskPercent, computeOpenRiskUSD } from './autoAiRiskLimits.js';
import { evaluateTradeCandidate } from './tradeDecisionEngine.js';
import {
  capPerTradeRiskPercent,
  checkMargin,
  checkRiskPerTrade,
  checkDailyRiskLock,
  reserveDailyLossBudget,
  checkAutoExecutionConfidence,
} from './riskManager.js';
import { computeV3EntryTpHitConfidence, computePostFillRiskReward, priceForMinimumRR, repriceV3TpHitConfidence } from './v3TpConfidence.js';

import { evaluateUniversalEntryPolicy, setupFingerprint } from './executionPolicy.js';
import { reserveExecution, markExecutionOpen, releaseExecution } from './executionReservations.js';
import { buildOandaMarketOrderPayload, repriceExecutableGeometry, validateDirectionLock } from './v3EntryContract.js';

import { evaluateUniversalEntryPolicy, setupFingerprint } from './executionPolicy.js';
import { reserveExecution, markExecutionOpen, releaseExecution } from './executionReservations.js';

import { evaluateUniversalEntryPolicy, setupFingerprint } from './executionPolicy.js';
import { reserveExecution, markExecutionOpen, releaseExecution } from './executionReservations.js';

import { evaluateUniversalEntryPolicy, setupFingerprint } from './executionPolicy.js';
import { reserveExecution, markExecutionOpen, releaseExecution } from './executionReservations.js';

import { HARD_SCALP_CONFIDENCE_FLOOR, isExplicitSwingSignal, normalizeScalpLifecycle } from './scalpOnlyPolicy.js';
// ─── Config from env ──────────────────────────────────────────────────────────
const AUTO_TRADE_ENABLED    = process.env.FOREX_AUTO_TRADE_ENABLED === 'true';
const MIN_SCORE             = parseInt(process.env.FOREX_MIN_SCORE     || '8',   10);
const MIN_CONFIDENCE        = Math.max(HARD_SCALP_CONFIDENCE_FLOOR, parseFloat(process.env.FOREX_MIN_CONFIDENCE || '85'));

// High-edge Auto AI gate. R:R alone is not enough; Auto AI must have probability edge.
const AUTO_AI_MIN_ENTRY_CONFIDENCE = parseFloat(process.env.AUTO_AI_MIN_ENTRY_CONFIDENCE || '85');
const AUTO_AI_MIN_ALIGNMENT_SCORE  = parseFloat(process.env.AUTO_AI_MIN_ALIGNMENT_SCORE  || '70');
const AUTO_AI_MIN_V3_SCORE         = parseFloat(process.env.AUTO_AI_MIN_V3_SCORE         || '70');
const AUTO_AI_MIN_TP_PROBABILITY   = parseFloat(process.env.AUTO_AI_MIN_TP_PROBABILITY   || '0.60');
const AUTO_AI_MIN_TP_SL_EDGE       = parseFloat(process.env.AUTO_AI_MIN_TP_SL_EDGE       || '0.15');
// Auto AI daily trade cap — env-driven, read at call time so it can be tuned
// without a rebuild. Prefers AUTO_AI_DAILY_TRADE_CAP; falls back to the legacy
// FOREX_MAX_DAILY_TRADES; safe default 10. This caps trade COUNT only — every
// risk/loss/margin/duplicate/live-ack guard remains fully enforced.
export function dailyTradeCap() {
  return Number(process.env.AUTO_AI_DAILY_TRADE_CAP || process.env.FOREX_MAX_DAILY_TRADES || 10);
}
export function isDailyTradeCapReached(count) {
  return Number(count) >= dailyTradeCap();
}
const MAX_SPREAD_PIPS       = parseFloat(process.env.FOREX_MAX_SPREAD_PIPS       || '5.0');
const MIN_EXECUTABLE_RR     = parseFloat(process.env.FOREX_MIN_EXECUTABLE_RR || '1.5');
const METALS_MAX_SPREAD_PIPS= parseFloat(process.env.METALS_MAX_SPREAD_PIPS      || '50');
const FIXED_LOT_SIZE        = parseFloat(process.env.FOREX_FIXED_LOT_SIZE        || '0.01');
const MIN_FREE_MARGIN_PCT        = parseFloat(process.env.FOREX_MIN_FREE_MARGIN_PCT   || '25');
const MAX_MARGIN_USAGE_FOR_NEW_TRADE = 0.35;  // block new trades when margin usage > 35% of NAV
const COOLDOWN_MS                = 5 * 60 * 1000;
// Hybrid (default): block on news.blocked + opposing institutional flow.
// Strict: also block on entryTiming.status==='too_early' (fib not retraced)
//         and 'wait_for_retest' (breakout without retest).
const ENTRY_TIMING_STRICT        = String(process.env.FOREX_ENTRY_TIMING_STRICT || 'false').toLowerCase() === 'true';

// ─── In-memory trade state (resets on server restart) ────────────────────────
let dailyTradeTimestamps = [];
let dailyLossUSD         = 0;
let lastTradeTime        = 0;
let dailyStartBalance    = null;
const activeTrades       = new Set();

export function resetDailyCounters() {
  const before = {
    activeTrades:     activeTrades.size,
    dailyTrades:      dailyTradeTimestamps.length,
    dailyLossUSD,
    cooldownMsLeft:   Math.max(0, COOLDOWN_MS - (Date.now() - lastTradeTime)),
  };
  dailyTradeTimestamps = [];
  dailyLossUSD         = 0;
  dailyStartBalance    = null;
  lastTradeTime        = 0;
  activeTrades.clear();
  console.log('[TRADE] Daily counters reset (in-memory only — no broker change).', before);
  return { ok: true, cleared: before };
}

export function recordTradeLoss(amountUSD) {
  dailyLossUSD += Math.abs(amountUSD);
  console.log(`[TRADE] Loss: $${amountUSD.toFixed(2)} | Daily total: $${dailyLossUSD.toFixed(2)}`);
}

// ─── Duplicate-trade reconciliation ───────────────────────────────────────────
// Local `activeTrades` holds keys like `EUR_USD_long`. Without broker verification
// these go stale when:
//   • TP/SL fires
//   • user closes the position manually
//   • the server restarts after we recorded the lock but before the close webhook
//
// Before rejecting a duplicate, we now query OANDA. If no live position matches,
// we delete the stale local lock and let the new trade proceed.

function normalizePair(instrument) {
  return String(instrument || '').replace('/', '_').toUpperCase();
}

function normalizeDirection(currentUnits) {
  const n = parseFloat(currentUnits);
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? 'long' : 'short';
}

/**
 * Returns `true` when an OANDA position genuinely matches the local lock.
 * Returns `false` when the lock is stale (and removes it).
 */
export async function reconcileTradeLock(pair, direction, options = {}) {
  const { client } = options;
  const key = `${pair}_${direction}`;
  console.log(`[TRADE LOCK CHECK] ${key}`);

  const hadLocalLock = activeTrades.has(key);

  let brokerTrades;
  try {
    brokerTrades = await getOpenTrades({ client });
  } catch (err) {
    // Be conservative: if we can't reach the broker, treat the lock as valid.
    console.warn(`[TRADE LOCK CHECK] ${key} — broker query failed (${err?.message || err}); keeping lock as a safety measure.`);
    return true;
  }

  const existsOnBroker = brokerTrades.some(t =>
    normalizePair(t.instrument) === pair &&
    normalizeDirection(t.currentUnits) === direction
  );

  if (existsOnBroker) {
    activeTrades.add(key);
    console.log(`[BROKER POSITION VERIFIED] ${key} — broker confirms an open position`);
    return true;
  }

  if (hadLocalLock) {
    console.warn(`[STALE LOCK REMOVED] ${key} — broker has no matching open position; releasing in-memory lock`);
    activeTrades.delete(key);
  } else {
    console.log(`[BROKER POSITION CLEAR] ${key} — no broker position exists`);
  }

  return false;
}

/**
 * Register a duplicate-protection lock for an opened position. Additive export
 * so the (isolated) ICT executor shares the SAME in-memory lock registry as the
 * V3 executeTrade path — preventing ICT and V3 from both opening the same pair.
 * executeTrade still adds its own lock inline; this does not change its behavior.
 */
export function registerTradeLock(pair, direction) {
  activeTrades.add(`${pair}_${direction}`);
}

/**
 * Startup / on-demand sweep: walk every local lock and verify it against OANDA.
 * Stale locks are removed; mismatched locks are logged.
 * Returns a summary the caller can log/report.
 */
export async function reconcileAllLocks(reason = 'startup', options = {}) {
  const { client } = options;
  if (activeTrades.size === 0) {
    console.log(`[TRADE LOCK CHECK] reconcileAllLocks(${reason}) — no local locks to verify`);
    return { ok: true, verified: 0, stale: 0, kept: 0, locksAfter: [] };
  }

  if (!client) {
    console.warn(`[TRADE LOCK CHECK] reconcileAllLocks(${reason}) — skipped: missing request-scoped OANDA client`);
    return { ok: false, skipped: true, reason: 'missing_request_scoped_oanda_client', locksAfter: Array.from(activeTrades) };
  }

  let brokerTrades;
  try {
    brokerTrades = await getOpenTrades({ client });
  } catch (err) {
    console.warn(`[TRADE LOCK CHECK] reconcileAllLocks(${reason}) — broker query failed: ${err?.message || err}`);
    return { ok: false, error: err?.message || String(err), locksAfter: Array.from(activeTrades) };
  }

  const brokerKeys = new Set(
    brokerTrades
      .map(t => {
        const pair = normalizePair(t.instrument);
        const dir  = normalizeDirection(t.currentUnits);
        return dir ? `${pair}_${dir}` : null;
      })
      .filter(Boolean)
  );

  const localKeys = Array.from(activeTrades);
  const stale = [];
  const kept  = [];
  for (const key of localKeys) {
    if (brokerKeys.has(key)) {
      kept.push(key);
      console.log(`[BROKER POSITION VERIFIED] ${key}`);
    } else {
      stale.push(key);
      activeTrades.delete(key);
      console.warn(`[STALE LOCK REMOVED] ${key} (reason=${reason})`);
    }
  }

  const summary = {
    ok: true,
    reason,
    verified: localKeys.length,
    stale: stale.length,
    kept: kept.length,
    staleKeys: stale,
    keptKeys: kept,
    brokerKeysSeen: Array.from(brokerKeys),
    locksAfter: Array.from(activeTrades),
  };
  console.log(`[TRADE LOCK CHECK] reconcileAllLocks(${reason}) — verified ${summary.verified}, kept ${summary.kept}, stale ${summary.stale}`);
  return summary;
}

// ─── Instrument helpers ───────────────────────────────────────────────────────

function getPipSize(pair) {
  if (pair.includes('JPY'))              return 0.01;
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return 0.01;
  return 0.0001;
}

function isMetalsPair(pair) {
  return pair === 'XAU_USD' || pair === 'XAG_USD';
}

function getUnitsForLotSize(pair, lotSize) {
  if (pair === 'XAU_USD') return Math.max(1, Math.round(lotSize * 100));
  if (pair === 'XAG_USD') return Math.max(1, Math.round(lotSize * 5000));
  return Math.round(lotSize * 100000);
}

const FALLBACK_LEVERAGE_FOREX  = 50;
const FALLBACK_LEVERAGE_METALS = 20;

/**
 * Calculate the correct USD notional value for any OANDA pair.
 *
 * OANDA units represent the BASE currency amount. Rules:
 *   USD base (USD_JPY, USD_CAD, USD_CHF): notional = units  [1 unit = $1]
 *   USD quote (EUR_USD, GBP_USD, AUD_USD): notional = units × price
 *   Metals (XAU_USD, XAG_USD):            notional = units × price
 *   Cross pairs (EUR_JPY, GBP_JPY, …):    fallback = units  [approximate]
 *
 * Example: 1,000 USD_JPY @ 157.865 → notional = $1,000 (NOT $157,865)
 */
function calculateForexNotionalUSD(pair, absUnits, entryPrice) {
  if (isMetalsPair(pair)) return absUnits * entryPrice;

  const [base, quote] = pair.split('_');
  if (base  === 'USD') return absUnits;               // USD_JPY, USD_CAD, USD_CHF
  if (quote === 'USD') return absUnits * entryPrice;  // EUR_USD, GBP_USD, AUD_USD, NZD_USD

  // Cross pairs (EUR_JPY, GBP_JPY, AUD_JPY, EUR_GBP, …)
  // No USD in the pair; treat each unit as ~1 USD (best approximation without a live cross rate).
  return absUnits;
}

/**
 * Estimate margin required for a trade.
 *   estimatedMargin = notionalUSD / leverage
 *
 * Leverage is read from OANDA account.marginRate (1 / 0.02 = 50:1).
 * Falls back to 50:1 forex / 20:1 metals when account field is absent.
 */
function estimateMarginRequired(pair, absUnits, price, accountMarginRate) {
  const metals = isMetalsPair(pair);
  const effectiveLeverage = (accountMarginRate > 0)
    ? 1 / accountMarginRate
    : (metals ? FALLBACK_LEVERAGE_METALS : FALLBACK_LEVERAGE_FOREX);

  const notionalUSD     = calculateForexNotionalUSD(pair, absUnits, price);
  const estimatedMargin = notionalUSD / effectiveLeverage;

  return { estimatedMargin, notionalUSD, effectiveLeverage };
}

// ─── Execution log helpers ────────────────────────────────────────────────────

function logEntry(phase, extra = {}) {
  return { phase, timestamp: new Date().toISOString(), ...extra };
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickFirstNumber(...values) {
  for (const v of values) {
    const n = numOrNull(v);
    if (n !== null) return n;
  }
  return null;
}

function estimateTpProbability(signal = {}) {
  // Prefer explicit model output if available.
  const explicit = pickFirstNumber(
    signal.tpProbability,
    signal.tpProb,
    signal.lifecycle?.tpProbability,
    signal.v3?.tpProbability,
    signal.v3Eval?.tpProbability,
  );
  if (explicit !== null) return explicit > 1 ? explicit / 100 : explicit;

  // Conservative fallback from score/confidence/V3. This prevents "unknown"
  // probability from being treated as safe.
  const confidence = pickFirstNumber(signal.confidence, 0) ?? 0;
  const v3Score = pickFirstNumber(signal.v3?.score, signal.v3Eval?.score, signal.score, 0) ?? 0;
  const alignment = pickFirstNumber(
    signal.alignment?.timeframeAlignmentScore,
    signal.multiTimeframeAlignmentScore,
    signal.currentAlignmentScore,
    50,
  ) ?? 50;

  const p =
    0.25 +
    Math.max(0, Math.min(100, confidence)) * 0.0025 +
    Math.max(0, Math.min(100, v3Score)) * 0.0020 +
    Math.max(0, Math.min(100, alignment)) * 0.0015;

  return Math.max(0.05, Math.min(0.85, +p.toFixed(3)));
}

function estimateSlProbability(signal = {}) {
  const explicit = pickFirstNumber(
    signal.slProbability,
    signal.slProb,
    signal.lifecycle?.slProbability,
    signal.v3?.slProbability,
    signal.v3Eval?.slProbability,
  );
  if (explicit !== null) return explicit > 1 ? explicit / 100 : explicit;
  return +(1 - estimateTpProbability(signal)).toFixed(3);
}

function hasV3EarlyTrigger(signal = {}) {
  const v3 = signal.v3 || signal.v3Eval || signal.v3Analysis || signal.metadata?.v3 || {};
  const early = signal.earlyTrigger ?? v3.earlyTrigger;
  if (early === true) return true;

  const liq = v3.liquidity || signal.liquidity || {};
  const structure = v3.structure || signal.structure || {};
  const vol = v3.volatility || signal.volatility || {};

  return (
    liq.liquiditySweepDetected === true ||
    liq.sweepDetected === true ||
    structure.chochDetected === true ||
    structure.bosDetected === true ||
    vol.volatilityState === 'expanding' ||
    vol.volatilityState === 'compressed'
  );
}

function highEdgeAutoAiGate(signal = {}, sizing = null) {
  const reasons = [];

  const pureV3 = isPureV3ExecutionSignal(signal);
  const confidence = pickFirstNumber(signal.tpHitConfidence, signal.confidence, 0) ?? 0;
  const alignment = pickFirstNumber(
    signal.alignment?.timeframeAlignmentScore,
    signal.multiTimeframeAlignmentScore,
    signal.currentAlignmentScore,
    0,
  ) ?? 0;

  const v3 = signal.v3 || signal.v3Eval || signal.v3Analysis || signal.metadata?.v3 || {};
  const v3Score = pickFirstNumber(v3.score, signal.v3Score, signal.score, 0) ?? 0;

  const tpProb = estimateTpProbability(signal);
  const slProb = estimateSlProbability(signal);
  const tpEdge = +(tpProb - slProb).toFixed(3);

  const timeDecay = String(
    signal.timeDecayRisk ??
    signal.lifecycle?.timeDecayRisk ??
    signal.management?.timeDecayRisk ??
    ''
  ).toLowerCase();

  const v3Targets = v3.targets || signal.targets || {};
  const remainingOpportunityOk =
    v3Targets.accepted !== false &&
    signal.lifecycle?.tp?.allowed !== false;

  const earlyTrigger = hasV3EarlyTrigger(signal);

  if (confidence < AUTO_AI_MIN_ENTRY_CONFIDENCE) {
    reasons.push(`confidence ${confidence} < ${AUTO_AI_MIN_ENTRY_CONFIDENCE}`);
  }

  if (!pureV3 && alignment < AUTO_AI_MIN_ALIGNMENT_SCORE) {
    reasons.push(`alignment ${alignment} < ${AUTO_AI_MIN_ALIGNMENT_SCORE}`);
  }

  if (v3Score < AUTO_AI_MIN_V3_SCORE) {
    reasons.push(`V3 score ${v3Score} < ${AUTO_AI_MIN_V3_SCORE}`);
  }

  if (tpProb < AUTO_AI_MIN_TP_PROBABILITY) {
    reasons.push(`TP probability ${(tpProb * 100).toFixed(0)}% < ${(AUTO_AI_MIN_TP_PROBABILITY * 100).toFixed(0)}%`);
  }

  if (tpEdge < AUTO_AI_MIN_TP_SL_EDGE) {
    reasons.push(`TP-SL edge ${(tpEdge * 100).toFixed(0)}% < ${(AUTO_AI_MIN_TP_SL_EDGE * 100).toFixed(0)}%`);
  }

  if (timeDecay === 'high') {
    reasons.push('time decay is high');
  }

  if (!earlyTrigger) {
    reasons.push('missing V3 early trigger');
  }

  if (!remainingOpportunityOk) {
    reasons.push('remaining opportunity rejected');
  }

  if (sizing) {
    const rr = Number(sizing?.riskReward ?? 0);
    if (!Number.isFinite(rr) || rr < 1.5) {
      reasons.push(`R:R ${Number.isFinite(rr) ? rr : 'n/a'} < 1.5`);
    }
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    metrics: {
      confidence,
      alignment,
      v3Score,
      tpProb,
      slProb,
      tpEdge,
      timeDecay: timeDecay || null,
      earlyTrigger,
      remainingOpportunityOk,
    },
  };
}

function rrNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function computePriceRiskReward({ direction, entry, stopLoss, takeProfit } = {}) {
  const e = Number(entry);
  const sl = Number(stopLoss);
  const tp = Number(takeProfit);

  if (!Number.isFinite(e) || !Number.isFinite(sl) || !Number.isFinite(tp)) {
    return null;
  }

  const risk = direction === 'long'
    ? e - sl
    : direction === 'short'
      ? sl - e
      : null;

  const reward = direction === 'long'
    ? tp - e
    : direction === 'short'
      ? e - tp
      : null;

  if (!Number.isFinite(risk) || !Number.isFinite(reward) || risk <= 0 || reward <= 0) {
    return null;
  }

  return +(reward / risk).toFixed(2);
}

function computeExecutableRiskReward(signal, { direction, entry, stopLoss, takeProfit } = {}) {
  const priceRR = computePriceRiskReward({ direction, entry, stopLoss, takeProfit });

  const directRR =
    rrNumber(signal?.expectedRR) ??
    rrNumber(signal?.rr) ??
    rrNumber(signal?.riskReward) ??
    rrNumber(signal?.riskRewardRatio) ??
    null;

  // Geometric price RR is the authority because it reflects the actual order.
  return priceRR ?? directRR;
}

function extractCreateTx(tx) {
  if (!tx) return null;
  return {
    id:         tx.id,
    type:       tx.type,
    instrument: tx.instrument,
    units:      tx.units,
    timeInForce:tx.timeInForce,
    price:      tx.price,
    time:       tx.time,
  };
}

function extractFillTx(tx) {
  if (!tx) return null;
  return {
    id:                    tx.id,
    type:                  tx.type,
    price:                 tx.price,
    time:                  tx.time,
    pl:                    tx.pl,
    units:                 tx.units,
    tradeId:               tx.tradeOpened?.tradeID,
    initialMarginRequired: tx.tradeOpened?.initialMarginRequired,
    marginRequired:        tx.marginRequired,
    accountBalance:        tx.accountBalance,
    fullVWAP:              tx.fullVWAP,
  };
}

function extractCancelTx(tx) {
  if (!tx) return null;
  return {
    id:           tx.id,
    type:         tx.type,
    reason:       tx.reason,
    cancelReason: tx.cancelReason,
    time:         tx.time,
    orderID:      tx.orderID,
  };
}

function isPureV3ExecutionSignal(signal = {}) {
  return (
    signal?.source === 'v3_pure_auto_ai' ||
    signal?.selectedLogicType === 'v3_pure' ||
    String(signal?.strategy || '').toUpperCase() === 'V3' ||
    signal?.engine === 'v3'
  );
}

// ─── Main execution function ──────────────────────────────────────────────────

/**
 * Execute a forex/metals trade via OANDA v20 using 3-phase execution:
 *   1. Bare IOC market order (no SL/TP).
 *   2. Confirm fill and get tradeID.
 *   3. Attach SL then TP via separate PUTs.
 *
 * @param {object} signal  Qualified signal from oandaScanner
 * @returns {object}       Enriched result with executionState and executionLog
 */
/**
 * Execute a forex/metals trade. 2026-05-27 multi-tenant refactor: accepts an
 * optional `{ client }` carrying the AUTHENTICATED USER's OANDA credentials.
 * When passed, every broker call (account summary, market order, SL/TP
 * updates) uses that user's credentials. When omitted, falls back to the
 * env-based default client (dev fallback only).
 *
 * @param {Object} signal
 * @param {Object} [options]
 * @param {Object} [options.client]
 */
function fitUnitsToMargin({
  signedUnits,
  estimatedMargin,
  marginAvailable,
  minFreeMarginUSD,
} = {}) {
  const units = Number(signedUnits);
  const margin = Number(estimatedMargin);
  const available = Number(marginAvailable);
  const minFree = Number(minFreeMarginUSD);

  if (!Number.isFinite(units) || !Number.isFinite(margin) || margin <= 0) {
    return { signedUnits, changed: false, reason: 'invalid margin fit inputs' };
  }

  const maxUsableMargin = Math.max(0, available - minFree);
  if (maxUsableMargin <= 0) {
    return { signedUnits: 0, changed: true, reason: 'no usable margin after free-margin reserve' };
  }

  if (margin <= maxUsableMargin) {
    return { signedUnits, changed: false, reason: 'already fits margin reserve' };
  }

  const ratio = maxUsableMargin / margin;
  const fittedAbsUnits = Math.floor(Math.abs(units) * ratio);
  const fittedSignedUnits = units < 0 ? -fittedAbsUnits : fittedAbsUnits;

  return {
    signedUnits: fittedSignedUnits,
    changed: true,
    ratio,
    maxUsableMargin,
    reason: `reduced units to fit usable margin $${maxUsableMargin.toFixed(2)}`,
  };
}

export async function executeTrade(signal, options = {}) {
  const { client, autoAi = false } = options;
  const {
    pair, direction, score, confidence: signalConfidence,
    entry, stopLoss, takeProfit, spreadPips,
  } = signal;
  const pureV3Execution = isPureV3ExecutionSignal(signal);
  let executableEntry = Number(entry);
  let executableGeometry = null;
  const entryQualityConfidence = Number(
    signal.entryQualityConfidence ?? signalConfidence ?? signal.v3?.confidence ?? 0
  );
  const tpHitConfidence = pureV3Execution
    ? computeV3EntryTpHitConfidence(signal)
    : null;
  const confidence = Number(entryQualityConfidence); // TP confidence is diagnostic only

  if (pureV3Execution) {
    signal.entryQualityConfidence = Number.isFinite(entryQualityConfidence) ? entryQualityConfidence : null;
    signal.tpHitConfidence = tpHitConfidence;
    signal.tpProbability = +(tpHitConfidence / 100).toFixed(3);
    signal.slProbability = +(1 - signal.tpProbability).toFixed(3);
    signal.tpConfidencePolicy = 'diagnostic_only';
    signal.confidence = entryQualityConfidence;
  }

  const tradeKey = `${pair}_${direction}`;
  const metals   = isMetalsPair(pair);
  const maxSpread = metals ? METALS_MAX_SPREAD_PIPS : MAX_SPREAD_PIPS;
  const pipSize   = getPipSize(pair);
  const priceDecimals = metals ? 2 : (pair.includes('JPY') ? 3 : 5);

  const executionLog = [];

  console.log(`\n[TRADE] ▶ Execution request: ${pair} ${direction.toUpperCase()}`);
  console.log(
    `[TRADE]   Score: ${score}/20, ${pureV3Execution ? 'TP Hit Conf' : 'Conf'}: ${confidence}%, ` +
    `Spread: ${spreadPips} pips`
  );

  // ── Guard 0: Paper-trading safety (2026-05-27) ────────────────────────────
  // Resolve the active environment and refuse live execution unless explicitly
  // allowed. Defaulting policy: missing / unknown environment → practice.
  // The signal payload MAY override the env (e.g. when a future per-user
  // broker_connection passes its own env), but never escalate from practice
  // to live without FOREX_ALLOW_LIVE_EXECUTION.
  const resolvedEnvironment = (() => {
    const sigEnv = String(signal?.environment || '').toLowerCase().trim();
    if (sigEnv === 'live') return 'live';
    if (sigEnv === 'paper' || sigEnv === 'practice') return 'practice';
    return getEnvironment();
  })();
  if (resolvedEnvironment === 'live' && !isLiveExecutionExplicitlyAllowed()) {
    console.log('[TRADE] ✗ Live execution requested but FOREX_ALLOW_LIVE_EXECUTION!=true');
    return blocked(
      'Live trading disabled or not selected. ' +
      'Set FOREX_ALLOW_LIVE_EXECUTION=true and pass environment="live" on the signal to enable.'
    );
  }
  if (resolvedEnvironment === 'practice') {
    console.log(`[TRADE]   Paper trading mode active: using OANDA practice endpoint for ${pair}`);
  } else {
    console.log(`[TRADE]   ⚠ LIVE EXECUTION ACTIVE — order will hit ${pair} on the live market`);
  }

  // ── Guard 1: Auto-trade enabled ───────────────────────────────────────────
  if (!AUTO_TRADE_ENABLED) {
    return blocked('Auto-trade is disabled (FOREX_AUTO_TRADE_ENABLED=false)');
  }

  // ── Guard 2: Score ────────────────────────────────────────────────────────
  if (score < MIN_SCORE) {
    return blocked(`Score ${score} < minimum ${MIN_SCORE}`);
  }

  // ── Guard 3: Entry execution probability ─────────────────────────────────
  const executionConfidenceFloor = MIN_CONFIDENCE;
  if (!Number.isFinite(confidence) || confidence < executionConfidenceFloor) {
    return blocked(`Entry-quality confidence ${Number.isFinite(confidence) ? confidence : 'n/a'}% < minimum ${executionConfidenceFloor}%`);
  }
  if (isExplicitSwingSignal(signal)) {
    return blocked('Scalp-only execution: swing trade signals are disabled.');
  }
  // Auto execution confidence floor (≥90) — central, applies to autonomous runs.
  if (autoAi) {
    const confCheck = checkAutoExecutionConfidence(confidence);
    if (!confCheck.passed) return blocked(confCheck.reason);
  }

  // ── Guard 3.5: Multi-timeframe trend alignment ────────────────────────────
  // Defensive check for legacy/waterfall signals only.
  // Pure V3 signals are gated by V3 structure/liquidity/session logic instead.
  if (!pureV3Execution) {
    const signalTrend     = signal.trend;
    const signalAlignment = signal.emaAlignment;
    const signalMtf       = signal.mtfAlignment;

    if (signalTrend === 'neutral' || signalAlignment === 'mixed') {
      console.log('[OANDA_TREND_ALIGNMENT_REJECT]', { pair, direction, trend: signalTrend, emaAlignment: signalAlignment });
      return blocked(`Trend alignment: trend=${signalTrend}, emaAlignment=${signalAlignment}`);
    }

    if (signalMtf?.conflicting && signalMtf?.h1Trend !== 'neutral' && signalMtf?.h4Trend !== 'neutral') {
      console.log('[OANDA_TREND_ALIGNMENT_REJECT]', {
        pair, direction, h1: signalMtf.h1Trend, h4: signalMtf.h4Trend,
      });
      return blocked(`MTF conflict: ${direction} vs H1=${signalMtf.h1Trend} H4=${signalMtf.h4Trend}`);
    }
  }

  if (pureV3Execution) {
    console.log(`[V3_PURE] ${pair} ${direction} — skipping legacy EMA/MTF gate; V3 liquidity/structure/session owns qualification.`);
  }

  // ── Guard 3.6: Entry-quality gates (HYBRID, configurable to STRICT) ──────
  // Hard-blocks (always on):
  //   - signal.newsRisk.blocked === true             → high-impact event in ±BLOCK window
  //   - signal.institutionalFlow opposing direction  → flow proxy contradicts setup
  // Soft (warn-only unless FOREX_ENTRY_TIMING_STRICT=true):
  //   - signal.entryTiming.status === 'too_early'    → fib not retraced yet
  //   - signal.entryTiming.status === 'wait_for_retest' → breakout without retest
  //
  // The scanner already filters these in hybrid mode, but executeTrade can be
  // called from /api/oanda/execute-trade with a stale or directly-crafted
  // signal — re-check defensively.
  {
    const news  = signal.newsRisk;
    const flow  = signal.institutionalFlow;
    const fib   = signal.fibonacci;
    const timing= signal.entryTiming;
    const tradeSign = direction === 'long' ? 'bullish' : 'bearish';

    if (news?.blocked) {
      const ev = news.upcomingEvents?.[0] || news.recentEvents?.[0];
      const evDesc = ev
        ? `${ev.impact}-impact ${ev.currency} news "${ev.title}" ${
            ev.minutesUntil != null ? `in ${ev.minutesUntil} minutes` : `${ev.minutesAgo}m ago`
          }`
        : news.reason;
      return blocked(`Rejected: ${evDesc}`);
    }

    if (
      !pureV3Execution &&
      flow?.detected &&
      flow.direction !== 'neutral' &&
      flow.direction !== tradeSign
    ) {
      const topSweep = (flow.signals || []).find(
        s => s.type === 'liquidity_sweep' && s.direction !== tradeSign
      );
      const reason = topSweep
        ? `Rejected: liquidity sweep suggests opposite direction (${topSweep.reason})`
        : `Rejected: institutional flow (${flow.type}) opposes ${direction} setup`;
      return blocked(reason);
    }

    if (!pureV3Execution && ENTRY_TIMING_STRICT && timing?.status === 'too_early') {
      const fibLabel = fib?.entryZone
        ? `${fib.entryZone.lower}–${fib.entryZone.upper}`
        : 'the 38.2–78.6% retracement band';
      return blocked(
        `Rejected: price has not retraced into H1/H4 Fibonacci entry zone (${fibLabel}). ${timing.reason}`
      );
    }
    if (!pureV3Execution && ENTRY_TIMING_STRICT && timing?.status === 'wait_for_retest') {
      return blocked(
        `Rejected: breakout occurred but retest not confirmed. ${timing.reason}`
      );
    }
    if (!pureV3Execution && timing && timing.status !== 'valid_entry') {
      // Hybrid mode — log only, but flag prominently.
      console.warn(
        `[ENTRY_TIMING] ⚠ ${pair} ${direction.toUpperCase()} — status=${timing.status}: ${timing.reason}. ` +
        `Proceeding because FOREX_ENTRY_TIMING_STRICT=false.`
      );
    }
  }

  const universalPolicy = evaluateUniversalEntryPolicy(signal);
  if (!universalPolicy.allowed) return blocked(`Universal entry policy: ${universalPolicy.reasons.join('; ')}`);

  if (pureV3Execution) {
    const stage2 = signal.qualityConfirmation?.stage2;
    if (stage2?.allowed !== true) {
      return blocked('Pure V3 execution requires a successful Stage 2 confirmation immediately before submission');
    }
    const directionLock = validateDirectionLock({
      candidateDirection: direction,
      confirmedDirection: signal.directionLock?.confirmedDirection || stage2.metrics?.lockedDirection,
      freshDirection: signal.directionLock?.freshDirection || stage2.metrics?.direction,
    });
    if (!directionLock.allowed) return blocked(`Direction lock rejected: ${directionLock.reasons.join('; ')}`);
  }

  const universalPolicy = evaluateUniversalEntryPolicy(signal);
  if (!universalPolicy.allowed) return blocked(`Universal entry policy: ${universalPolicy.reasons.join('; ')}`);

  // ── Guard 4: SL and TP present ────────────────────────────────────────────
  if (!stopLoss || !takeProfit) {
    return blocked('stopLoss or takeProfit not set on signal');
  }

  // Universal hard R:R gate. No scanner, V3 promotion, dashboard signal, or
  // direct API call may execute a trade below 1.5R.
  const preSizingRR = computeExecutableRiskReward(signal, {
    direction,
    entry,
    stopLoss,
    takeProfit,
  });

  if (!Number.isFinite(preSizingRR) || preSizingRR < MIN_EXECUTABLE_RR) {
    return blocked(
      `Risk reward ${Number.isFinite(preSizingRR) ? preSizingRR : 'n/a'} < minimum ${MIN_EXECUTABLE_RR}`
    );
  }

  // ── Guard 5: Spread ───────────────────────────────────────────────────────
  console.log(`[OANDA_SPREAD_CHECK] instrument=${pair} spreadPips=${spreadPips} max=${maxSpread}`);
  if (spreadPips > maxSpread) {
    return blocked(`Spread ${spreadPips} pips > max ${maxSpread} (${metals ? 'metals' : 'forex'})`);
  }

  // ── Guard 6: Cooldown ─────────────────────────────────────────────────────
  const now = Date.now();
  if (now - lastTradeTime < COOLDOWN_MS) {
    const waitSec = Math.ceil((COOLDOWN_MS - (now - lastTradeTime)) / 1000);
    return blocked(`Cooldown active — wait ${waitSec}s before next trade`);
  }

  // ── Guard 7: No duplicate (reconciled against OANDA) ──────────────────────
  // Local lock is checked first, but never trusted on its own. We verify against
  // live broker positions; a stale lock is removed automatically and we proceed.
  const stillActive = await reconcileTradeLock(pair, direction, { client });
  if (stillActive) {
    console.warn(`[DUPLICATE TRADE REJECTED] ${tradeKey} — broker confirms an open position with same side`);
    return blocked(`Duplicate trade already active: ${tradeKey}`);
  }

  // ── Guard 8: Daily cap (count only — risk/loss guards below stay enforced) ──
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  dailyTradeTimestamps = dailyTradeTimestamps.filter((t) => t > todayStart.getTime());
  const cap = dailyTradeCap();
  if (dailyTradeTimestamps.length >= cap) {
    return blocked(`Daily trade cap reached: ${dailyTradeTimestamps.length}/${cap}`);
  }

  // ── Guard 9: Account + balance + daily loss cap ───────────────────────────
  let account;
  try {
    account = await getAccountSummary({ client });
  } catch (err) {
    return blocked(`Failed to fetch account: ${err.message}`);
  }

  const balanceUSD      = parseFloat(account.balance       || 0);
  const marginAvailable = parseFloat(account.marginAvailable || 0);

  if (balanceUSD === 0 || isNaN(balanceUSD)) {
    return blocked('Account balance is 0. Fund account before live trading.');
  }

  // ── Daily drawdown circuit breaker (central, blocks NEW entries only) ──────
  const dailyLock = checkDailyRiskLock({ accountId: client?.accountId, balanceUSD });
  if (dailyLock.tradingLocked) {
    return blocked(dailyLock.reason);
  }

  if (pureV3Execution) {
    let freshPricing;
    try {
      const pricingPayload = await getPricing([pair], { client });
      freshPricing = Array.isArray(pricingPayload)
        ? pricingPayload.find((row) => row?.instrument === pair || row?.pair === pair || row?.symbol === pair)
        : pricingPayload?.[pair] || pricingPayload?.[String(pair).replace('_', '/')] || pricingPayload;
    } catch (err) {
      return blocked(`Executable quote fetch failed: ${err.message}`);
    }

    executableGeometry = repriceExecutableGeometry(signal, freshPricing || {}, {
      minRR: MIN_EXECUTABLE_RR,
      maxSpreadPips: maxSpread,
      maxPriceDriftAtr: Number(process.env.V3_QUALITY_MAX_PRICE_DRIFT_ATR || 0.15),
    });
    executionLog.push(logEntry('V3_EXECUTABLE_GEOMETRY', executableGeometry));
    if (!executableGeometry.allowed) {
      return blocked(`Executable geometry rejected: ${executableGeometry.reasons.join('; ')}`);
    }
    executableEntry = executableGeometry.entry;
    signal.entry = executableEntry;
    signal.entryPrice = executableEntry;
    signal.currentPrice = executableEntry;
    signal.spreadPips = executableGeometry.spreadPips;
  }

  // ── Guard 10: Dynamic risk sizing + pre-trade margin check ──────────────
  // Recompute server-side: confidence drives risk budget; the signal carries
  // the lifecycle result (SL/TP/hold), but if it's stale or missing, recompute
  // lifecycle from fresh candles so the order matches current structure.
  const accountMarginRate = parseFloat(account.marginRate || 0);

  console.warn(`[TRADE] ⚠ ${DYNAMIC_RISK_NOTICE}`);

  const dynamicRisk = computeDynamicTradeRisk({
    accountBalanceUSD: balanceUSD,
    confidence: signal.confidence,
    score: signal.score,
    minConfidence: MIN_CONFIDENCE,
    spreadPips: signal.spreadPips,
    maxSpreadPips: maxSpread,
    volatilityState: signal.volatilityState,
  });

  if (!dynamicRisk.allowed) {
    return blocked(
      `Dynamic risk sizing rejected (${dynamicRisk.reason}). ` +
      `balance=$${balanceUSD.toFixed(2)} confidence=${signal.confidence}%`
    );
  }

  // Hard per-trade risk cap (RISK_MAX_PER_TRADE_PERCENT) — applies to EVERY trade
  // (manual + auto). No confidence/quality score may override it.
  {
    const cap = capPerTradeRiskPercent(dynamicRisk.riskPercent);
    if (dynamicRisk.riskPercent > cap) {
      const cappedRiskUSD = +(balanceUSD * (cap / 100)).toFixed(2);
      console.log(
        `[RISK CAP] ${pair} ${direction} — capping risk ${dynamicRisk.riskPercent}% → ${cap}% ` +
        `($${dynamicRisk.riskUSD} → $${cappedRiskUSD})`
      );
      dynamicRisk.riskPercent = cap;
      dynamicRisk.riskUSD = cappedRiskUSD;
    }
  }

  let openTradesForBudget = [];
  try { openTradesForBudget = (await getOpenTrades({ client })) || []; }
  catch (err) { return blocked(`Could not calculate open stop risk: ${err.message}`); }
  const dailyBudget = reserveDailyLossBudget({
    accountId: client?.accountId,
    balanceUSD,
    openRiskUSD: computeOpenRiskUSD(openTradesForBudget),
    requestedRiskUSD: dynamicRisk.riskUSD,
  });
  if (!dailyBudget.allowed) return blocked(dailyBudget.reason);
  if (dailyBudget.capped) {
    dynamicRisk.riskUSD = dailyBudget.approvedRiskUSD;
    dynamicRisk.riskPercent = +((dailyBudget.approvedRiskUSD / balanceUSD) * 100).toFixed(4);
  }

  // Use the signal's lifecycle SL/TP if present and fresh; otherwise recompute.
  let slPips, slPriceFromLifecycle, tpPips, tpPriceFromLifecycle;
  if (pureV3Execution && executableGeometry) {
    slPips = executableGeometry.stopDistancePips;
    slPriceFromLifecycle = executableGeometry.stopLoss;
    tpPips = executableGeometry.targetDistancePips;
    tpPriceFromLifecycle = executableGeometry.takeProfit;
    console.log(`[TRADE] Repriced V3 geometry from ${executableGeometry.priceSide}: entry=${executableEntry} SL=${slPips.toFixed(1)}p TP=${tpPips.toFixed(1)}p RR=${executableGeometry.riskReward}`);
  } else if (signal.lifecycle?.sl && signal.lifecycle?.tp && signal.lifecycle.tp.allowed !== false) {
    slPips                = signal.lifecycle.sl.stopLossPips;
    slPriceFromLifecycle  = signal.lifecycle.sl.stopLossPrice;
    tpPips                = signal.lifecycle.tp.takeProfitPips;
    tpPriceFromLifecycle  = signal.lifecycle.tp.takeProfitPrice;
    console.log(`[TRADE] Using signal-supplied lifecycle: SL=${slPips}p TP=${tpPips}p`);
  } else {
    console.warn('[TRADE] Signal has no lifecycle data — recomputing from fresh candles.');
    const [m15CandlesLive, h1CandlesLive] = await Promise.all([
      getCandles(pair, 'M15', 80, { client }).catch(() => []),
      getCandles(pair, 'H1',  80, { client }).catch(() => []),
    ]);
    const lifecycle = computeTradeLifecycle({
      pair, direction, entryPrice: executableEntry,
      atrPips: signal.momentum?.atrPips,
      m15Candles: m15CandlesLive,
      h1Candles:  h1CandlesLive,
      spreadPips: signal.spreadPips,
      maxSpreadPips: maxSpread,
      session:  signal.session,
      macro:     signal.macro,
      structure: signal.structure,
      momentum:  signal.momentum,
      alignment: signal.alignment,
      fibonacci: signal.fibonacci,
      institutionalFlow: signal.institutionalFlow,
    });
    if (!lifecycle.allowed) {
      return blocked(`Lifecycle reject at execution: ${lifecycle.rejectionReason}`);
    }
    slPips               = lifecycle.sl.stopLossPips;
    slPriceFromLifecycle = lifecycle.sl.stopLossPrice;
    tpPips               = lifecycle.tp.takeProfitPips;
    tpPriceFromLifecycle = lifecycle.tp.takeProfitPrice;
  }

  const scalpLifecycle = normalizeScalpLifecycle({
    pair,
    direction,
    entryPrice: executableEntry,
    atrPips: signal.atrPips ?? signal.momentum?.atrPips,
    lifecycle: {
      allowed: true,
      sl: {
        ...(signal.lifecycle?.sl || {}),
        stopLossPips: slPips,
        stopLossPrice: slPriceFromLifecycle,
      },
      tp: {
        ...(signal.lifecycle?.tp || {}),
        allowed: true,
        takeProfitPips: tpPips,
        takeProfitPrice: tpPriceFromLifecycle,
      },
      hold: signal.lifecycle?.hold || null,
    },
  });

  if (!scalpLifecycle.allowed) {
    return blocked(scalpLifecycle.reason);
  }

  slPips = scalpLifecycle.lifecycle.sl.stopLossPips;
  slPriceFromLifecycle = scalpLifecycle.lifecycle.sl.stopLossPrice;
  tpPips = scalpLifecycle.lifecycle.tp.takeProfitPips;
  tpPriceFromLifecycle = scalpLifecycle.lifecycle.tp.takeProfitPrice;

  const sizing = computeFixedDollarSizing({
    pair,
    direction,
    entryPrice: executableEntry,
    targetRiskUSD: dynamicRisk.riskUSD,
    stopLossPips:   slPips,
    stopLossPrice:  slPriceFromLifecycle,
    takeProfitPips: tpPips,
    takeProfitPrice: tpPriceFromLifecycle,
    accountMarginRate,
    accountBalanceUSD: balanceUSD,
  });

  const finalRiskReward = Number(sizing?.riskReward ?? 0);
  if (!Number.isFinite(finalRiskReward) || finalRiskReward < 1.5) {
    return blocked(`Risk reward ${Number.isFinite(finalRiskReward) ? finalRiskReward : 'n/a'} < minimum 1.5 after execution sizing`);
  }

  const finalSizingRR = Number(sizing?.riskReward ?? 0);
  if (!Number.isFinite(finalSizingRR) || finalSizingRR < MIN_EXECUTABLE_RR) {
    return blocked(
      `Risk reward ${Number.isFinite(finalSizingRR) ? finalSizingRR : 'n/a'} < minimum ${MIN_EXECUTABLE_RR} after sizing`
    );
  }

  let units                 = sizing.signedUnits;
  let absUnits              = Math.abs(units);
  const slPrice             = sizing.stopLoss;
  const tpPrice             = sizing.takeProfit;
  let estimatedMargin       = sizing.estimatedMarginRequired;
  let notionalUSD           = sizing.notionalUSD;
  const effectiveLeverage   = sizing.effectiveLeverage;
  const slDistancePips      = sizing.stopLossPips;

  const minFreeMarginUSD    = balanceUSD * (MIN_FREE_MARGIN_PCT / 100);

  if (autoAi) {
    const fit = fitUnitsToMargin({
      signedUnits: units,
      estimatedMargin,
      marginAvailable,
      minFreeMarginUSD,
    });

    if (fit.changed) {
      console.warn(
        `[AUTO_AI_MARGIN_FIT] ${pair} ${direction} ${fit.reason}; ` +
        `units ${units} → ${fit.signedUnits}`
      );

      units = fit.signedUnits;
      absUnits = Math.abs(units);

      if (absUnits >= 1) {
        const unitRatio = absUnits / Math.abs(sizing.signedUnits || 1);
        estimatedMargin = +(sizing.estimatedMarginRequired * unitRatio).toFixed(2);
        notionalUSD = +(sizing.notionalUSD * unitRatio).toFixed(2);
        sizing.signedUnits = units;
        sizing.tradeUnits = absUnits;
        sizing.estimatedMarginRequired = estimatedMargin;
        sizing.notionalUSD = notionalUSD;
        sizing.actualRiskUSD = +(sizing.actualRiskUSD * unitRatio).toFixed(2);
        sizing.estimatedRewardUSD = +(sizing.estimatedRewardUSD * unitRatio).toFixed(2);
      }
    }
  }

  if (!absUnits || absUnits < 1) {
    return blocked(
      `Sizing produced 0 units after margin fit — not enough free margin. ` +
      `available=$${marginAvailable.toFixed(2)} minFree=$${minFreeMarginUSD.toFixed(2)}`
    );
  }

  const projectedFreeMargin = marginAvailable - estimatedMargin;

  console.log(
    `[RISK_SIZING] ${pair} ${direction} — mode=${RISK_MODE} target=$${sizing.targetRiskUSD} ` +
    `actual=$${sizing.actualRiskUSD} reward=$${sizing.estimatedRewardUSD} (1:${sizing.riskReward}) ` +
    `units=${absUnits} lots=${sizing.lotSize} SL=${slDistancePips}p TP=${sizing.takeProfitPips}p`
  );
  console.log(
    `[MARGIN_CHECK] ${pair} — notional $${notionalUSD.toFixed(2)} / ${effectiveLeverage}:1 = ` +
    `$${estimatedMargin.toFixed(2)} | available $${marginAvailable.toFixed(2)} | ` +
    `projectedFree $${projectedFreeMargin.toFixed(2)} | minRequired $${minFreeMarginUSD.toFixed(2)} ` +
    `(${MIN_FREE_MARGIN_PCT}% of balance)`
  );

  if (sizing.warnings.length > 0) {
    for (const w of sizing.warnings) console.warn(`[TRADE]   ⚠ ${w}`);
  }

  // ── Central margin guard — never submit an order we cannot afford margin for ─
  {
    const marginCheck = checkMargin({ marginAvailable, estimatedMargin });
    if (!marginCheck.allowed) {
      console.warn(`[MARGIN] ${pair} avail=$${marginAvailable.toFixed(2)} required=$${estimatedMargin.toFixed(2)}`);
      return blocked(marginCheck.reason);
    }
  }

  // ── Central hard risk-per-trade validation (actual sized risk ≤ 1.4%) ──────
  {
    const riskCheck = checkRiskPerTrade({
      balanceUSD, actualDollarRisk: sizing.actualRiskUSD, stopLossPips: slDistancePips, positionSize: absUnits,
    });
    if (!riskCheck.passed) return blocked(riskCheck.reason);
  }

  // ── Auto AI portfolio guard: total-open-risk cap ──────────────────────────
  if (autoAi) {
    let openTrades = [];
    try {
      openTrades = (await getOpenTrades({ client })) || [];
    } catch (err) {
      console.warn(`[AUTO_AI_OPEN_RISK] open-risk check skipped — ${err.message}`);
    }
    const currentOpenRiskPercent = computeOpenRiskPercent(openTrades, balanceUSD) ?? 0;
    const newTradeRiskPercent = +((sizing.actualRiskUSD / balanceUSD) * 100).toFixed(4);
    const totalCheck = checkTotalOpenRisk(currentOpenRiskPercent, newTradeRiskPercent);
    if (!totalCheck.allowed) {
      console.warn(`[AUTO_AI_OPEN_RISK] ${pair} ${totalCheck.reason}`);
      return blocked(totalCheck.reason);
    }
  }

  if (projectedFreeMargin < minFreeMarginUSD) {
    return {
      success:        false,
      blocked:        true,
      reason:
        `Dynamic risk mode: required margin exceeds allowance. ` +
        `For $${dynamicRisk.riskUSD} risk (${dynamicRisk.riskPercent}% of $${balanceUSD.toFixed(2)}) at ${slDistancePips}p stop ` +
        `the broker needs $${estimatedMargin.toFixed(2)} margin, ` +
        `which leaves projected free $${projectedFreeMargin.toFixed(2)} < min $${minFreeMarginUSD.toFixed(2)} ` +
        `(${MIN_FREE_MARGIN_PCT}% of $${balanceUSD.toFixed(2)} balance). ` +
        `Trade blocked. Lower FOREX_MAX_RISK_PERCENT or fund the account before retrying.`,
      executionState:          'REJECTED',
      notionalUSD,
      marginAvailable,
      marginRequired:           estimatedMargin,
      projectedFreeMargin,
      leverage:                 effectiveLeverage,
      sizing,
      executionLog,
    };
  }

  const riskAmount = sizing.actualRiskUSD;
  // Use the per-request client's accountId when present; fall back to env-default.
  const accountId  = client?.accountId || getAccountId();

  executionLog.push(logEntry('SIZING_DYNAMIC', {
    riskMode: sizing.riskMode,
    riskPercent: dynamicRisk.riskPercent,
    riskUSD: dynamicRisk.riskUSD,
    accountBalanceUSD: balanceUSD,
    confidence: signal.confidence,
    score: signal.score,
    spreadPips: signal.spreadPips,
    volatilityState: signal.volatilityState,
    modifiers: dynamicRisk.factors.modifiers,
    targetRiskUSD: sizing.targetRiskUSD,
    actualRiskUSD: sizing.actualRiskUSD,
    estimatedRewardUSD: sizing.estimatedRewardUSD,
    minimumRiskReward: sizing.minimumRiskReward,
    stopLossPips: sizing.stopLossPips,
    takeProfitPips: sizing.takeProfitPips,
    tradeUnits: absUnits,
    lotSize: sizing.lotSize,
    pipValuePerStandardLot: sizing.pipValuePerStandardLot,
    notionalUSD: sizing.notionalUSD,
    effectiveLeverage: sizing.effectiveLeverage,
    warnings: sizing.warnings,
  }));

  executionLog.push(logEntry('MARGIN_CHECK', {
    estimatedMarginCalculation:
      `$${notionalUSD.toFixed(2)} / ${effectiveLeverage.toFixed(1)}:1 = $${estimatedMargin.toFixed(2)}`,
    notionalUSD:        +notionalUSD.toFixed(2),
    effectiveLeverage:  +effectiveLeverage.toFixed(1),
    estimatedMargin:    +estimatedMargin.toFixed(2),
    marginAvailable:    +marginAvailable.toFixed(2),
    projectedFreeMargin:+projectedFreeMargin.toFixed(2),
    minFreeMarginUSD:   +minFreeMarginUSD.toFixed(2),
  }));

  // ═══════════════════════════════════════════════════════════════════════════
  // ATOMIC MARKET ORDER — SL + TP attached on the initial order itself.
  // OANDA: stopLossOnFill / takeProfitOnFill bind to the fill transaction, so
  // SL/TP cannot be missed even on partial slippage.
  // ═══════════════════════════════════════════════════════════════════════════

  const setupKey = setupFingerprint(signal, accountId);
  const executionReservation = await reserveExecution({ fingerprint: setupKey, accountId, pair, direction });
  if (!executionReservation.allowed) return blocked(`Atomic setup reservation rejected: ${executionReservation.reason}`);
  const executionReservationHash = executionReservation.hash;

  const orderPayload = buildOandaMarketOrderPayload({
    pair,
    signedUnits: units,
    stopLoss: slPrice,
    takeProfit: tpPrice,
    priceDecimals,
  });

  console.log(`[ORDER_PAYLOAD] ${pair} ${direction} atomic IOC MARKET + SL/TP onFill`);
  console.log(`[ORDER_PAYLOAD]`, JSON.stringify(orderPayload));

  let oandaResponse;
  try {
    // Route through the per-request client when provided; legacy oandaPost
    // is only used when no client was passed (dev fallback).
    if (client) {
      oandaResponse = await client.post(
        `/v3/accounts/${accountId}/orders`,
        orderPayload
      );
    } else {
      oandaResponse = await oandaPost(
        `/v3/accounts/${accountId}/orders`,
        orderPayload
      );
    }
  } catch (err) {
    console.error(`[TRADE] ✗ Order submission error: ${err.message}`);
    executionLog.push(logEntry('SUBMIT_ERROR', { error: err.message }));
    await releaseExecution(executionReservationHash, 'failed');
    await releaseExecution(executionReservationHash, 'failed');
    await releaseExecution(executionReservationHash, 'failed');
    await releaseExecution(executionReservationHash, 'failed');
    return {
      success:        false,
      blocked:        false,
      executionState: 'REJECTED',
      reason:         `Order submission failed: ${err.message}`,
      rejectReason:   err.message,
      sizing,
      executionLog,
      marginAvailable,
      marginRequired: estimatedMargin,
    };
  }

  const { orderCreateTransaction, orderFillTransaction, orderCancelTransaction } = oandaResponse;

  if (orderCreateTransaction) {
    const createInfo = extractCreateTx(orderCreateTransaction);
    console.log(`[TRADE]   orderCreateTransaction: id=${createInfo.id}, type=${createInfo.type}`);
    executionLog.push(logEntry('ORDER_CREATE', { transaction: createInfo }));
  }

  if (orderCancelTransaction) {
    const cancelInfo   = extractCancelTx(orderCancelTransaction);
    const cancelReason = cancelInfo.reason || cancelInfo.cancelReason || 'UNKNOWN';
    console.log(`[TRADE] ✗ Order CANCELLED by OANDA: ${cancelReason}`);
    executionLog.push(logEntry('ORDER_CANCEL', { transaction: cancelInfo, cancelReason }));
    await releaseExecution(executionReservationHash, 'cancelled');
    await releaseExecution(executionReservationHash, 'cancelled');
    await releaseExecution(executionReservationHash, 'cancelled');
    await releaseExecution(executionReservationHash, 'cancelled');
    return {
      success:        false,
      blocked:        false,
      executionState: 'CANCELLED',
      reason:         `Order cancelled by OANDA: ${cancelReason}`,
      cancelReason,
      sizing,
      marginAvailable,
      marginRequired: estimatedMargin,
      executionLog,
      oandaResponse,
    };
  }

  if (!orderFillTransaction) {
    const rejectReason =
      'No fill transaction in OANDA response — IOC order found no liquidity';
    console.log(`[TRADE] ✗ Order REJECTED (no fill transaction)`);
    executionLog.push(logEntry('ORDER_REJECTED', { rejectReason, oandaResponse }));
    return {
      success:        false,
      blocked:        false,
      executionState: 'REJECTED',
      reason:         rejectReason,
      rejectReason,
      sizing,
      marginAvailable,
      marginRequired: estimatedMargin,
      executionLog,
      oandaResponse,
    };
  }

  // Fill confirmed — SL/TP were attached atomically. Revalidate using the ACTUAL
  // broker fill because market slippage can change geometric R:R after submission.
  const fillInfo        = extractFillTx(orderFillTransaction);
  const tradeId         = fillInfo.tradeId;
  await markExecutionOpen({ hash: executionReservationHash, tradeId });
  await markExecutionOpen({ hash: executionReservationHash, tradeId });
  await markExecutionOpen({ hash: executionReservationHash, tradeId });
  await markExecutionOpen({ hash: executionReservationHash, tradeId });
  const fillPrice       = parseFloat(fillInfo.price || executableEntry);
  const tradeMarginUsed = parseFloat(
    fillInfo.initialMarginRequired || fillInfo.marginRequired || 0
  );

  // Count and lock every confirmed broker fill immediately. A successful emergency
  // flatten removes only the active lock; the daily fill count remains accurate.
  lastTradeTime = Date.now();
  dailyTradeTimestamps.push(lastTradeTime);
  activeTrades.add(tradeKey);

  let effectiveTpPrice = tpPrice;
  let postFillTpAdjusted = false;
  let actualFillRR = computePostFillRiskReward({
    direction,
    entry: fillPrice,
    stopLoss: slPrice,
    takeProfit: effectiveTpPrice,
  });

  const flattenPostFillTrade = async (reason) => {
    const closePath = tradeId
      ? `/v3/accounts/${accountId}/trades/${tradeId}/close`
      : `/v3/accounts/${accountId}/positions/${pair}/close`;
    const closeBody = tradeId
      ? { units: 'ALL' }
      : (direction === 'long' ? { longUnits: 'ALL' } : { shortUnits: 'ALL' });
    const response = client
      ? await client.put(closePath, closeBody)
      : await oandaPut(closePath, closeBody);
    activeTrades.delete(tradeKey);
    return response;
  };

  if (!Number.isFinite(actualFillRR) || actualFillRR < MIN_EXECUTABLE_RR) {
    const repairedTp = priceForMinimumRR({
      direction,
      fillPrice,
      stopLoss: slPrice,
      minRR: MIN_EXECUTABLE_RR,
      priceDecimals,
    });

    try {
      if (!tradeId || !Number.isFinite(repairedTp)) {
        throw new Error('missing tradeId or valid repaired TP');
      }
      const dependentOrderPath = `/v3/accounts/${accountId}/trades/${tradeId}/orders`;
      const dependentOrderBody = {
        takeProfit: { price: repairedTp.toFixed(priceDecimals), timeInForce: 'GTC' },
      };
      if (client) await client.put(dependentOrderPath, dependentOrderBody);
      else await oandaPut(dependentOrderPath, dependentOrderBody);

      effectiveTpPrice = repairedTp;
      actualFillRR = computePostFillRiskReward({
        direction,
        entry: fillPrice,
        stopLoss: slPrice,
        takeProfit: effectiveTpPrice,
      });
      postFillTpAdjusted = true;
      executionLog.push(logEntry('POST_FILL_RR_REPAIRED', {
        fillPrice,
        stopLoss: slPrice,
        previousTakeProfit: tpPrice,
        repairedTakeProfit: effectiveTpPrice,
        actualFillRR,
        minimumRR: MIN_EXECUTABLE_RR,
      }));
    } catch (repairError) {
      let closedAfterFill = false;
      let closeError = null;
      try {
        await flattenPostFillTrade(repairError.message);
        closedAfterFill = true;
      } catch (err) {
        closeError = err?.message || String(err);
      }

      console.error(
        `[POST_FILL_RR] ${pair} ${direction} fill=${fillPrice} RR=${actualFillRR ?? 'n/a'} ` +
        `repair failed (${repairError.message}); closed=${closedAfterFill}`
      );
      return {
        success: false,
        blocked: false,
        executionState: 'POST_FILL_RR_REJECTED',
        reason:
          `Actual fill R:R ${Number.isFinite(actualFillRR) ? actualFillRR : 'n/a'} < ${MIN_EXECUTABLE_RR}; ` +
          `TP repair failed and the fill was ${closedAfterFill ? 'closed immediately' : 'NOT closed automatically'}.`,
        tradeId,
        fillPrice,
        actualFillRR,
        minimumRR: MIN_EXECUTABLE_RR,
        closedAfterFill,
        closeError,
        sizing,
        executionLog,
        oandaResponse,
      };
    }
  }

  // A rounded dependent-order price must still pass the universal hard floor.
  if (!Number.isFinite(actualFillRR) || actualFillRR < MIN_EXECUTABLE_RR) {
    let closedAfterFill = false;
    let closeError = null;
    try {
      await flattenPostFillTrade('repaired TP still below minimum RR');
      closedAfterFill = true;
    } catch (err) {
      closeError = err?.message || String(err);
    }
    return {
      success: false,
      blocked: false,
      executionState: 'POST_FILL_RR_REJECTED',
      reason: `Actual fill R:R remained ${actualFillRR ?? 'n/a'} < ${MIN_EXECUTABLE_RR} after repair.`,
      tradeId,
      fillPrice,
      actualFillRR,
      closedAfterFill,
      closeError,
      sizing,
      executionLog,
      oandaResponse,
    };
  }
  const postFillTpHitConfidence = pureV3Execution ? repriceV3TpHitConfidence({ baseConfidence: tpHitConfidence, originalRR: finalSizingRR, actualRR: actualFillRR }) : null;
  if (pureV3Execution) {
    signal.preFillTpHitConfidence = tpHitConfidence;
    signal.tpHitConfidence = postFillTpHitConfidence;
    signal.entryTpHitConfidence = postFillTpHitConfidence;
    signal.tpProbability = +(postFillTpHitConfidence / 100).toFixed(3);
    signal.slProbability = +(1 - signal.tpProbability).toFixed(3);
    signal.confidence = postFillTpHitConfidence;
  }

  // Make the persisted sizing/history reflect broker reality, not the pre-fill quote.
  const actualRiskPips = Math.abs(fillPrice - slPrice) / pipSize;
  const actualRewardPips = Math.abs(effectiveTpPrice - fillPrice) / pipSize;
  sizing.stopLoss = slPrice;
  sizing.takeProfit = effectiveTpPrice;
  sizing.stopLossPips = +actualRiskPips.toFixed(2);
  sizing.takeProfitPips = +actualRewardPips.toFixed(2);
  sizing.riskReward = +actualFillRR.toFixed(2);
  signal.originalSignalEntry = entry;
  signal.entry = fillPrice;
  signal.entryPrice = fillPrice;
  signal.stopLoss = slPrice;
  signal.takeProfit = effectiveTpPrice;
  signal.targetProfit = effectiveTpPrice;
  signal.actualFillRR = +actualFillRR.toFixed(2);
  signal.postFillTpAdjusted = postFillTpAdjusted;

  console.log(
    `[TRADE] ✓ FILLED + SL/TP attached — tradeId=${tradeId}, price=${fillPrice}, ` +
    `actualRR=${actualFillRR.toFixed(2)}, tpAdjusted=${postFillTpAdjusted}, ` +
    `marginRequired=$${tradeMarginUsed.toFixed(2)}`
  );

  executionLog.push(logEntry('ORDER_FILL', {
    transaction: fillInfo,
    tradeId,
    fillPrice,
    marginRequired: tradeMarginUsed,
    stopLoss: slPrice,
    takeProfit: effectiveTpPrice,
    actualFillRR,
    postFillTpAdjusted,
    atomicSlTp: true,
  }));

  return buildResult({
    executionState: 'TP_ATTACHED', // SL+TP both attached on fill — terminal state
    tradeId,
    fillPrice,
    marginRequired: tradeMarginUsed,
    marginAvailable,
    projectedFreeMargin,
    leverage: effectiveLeverage,
    notionalUSD,
    executionLog,
    oandaResponse,
    units,
    riskAmount,
    sizing,
    signal,
    entry: fillPrice,
    stopLoss: slPrice,
    takeProfit: effectiveTpPrice,
    score,
    confidence,
  });
}

// ─── Build final result + record trade history ────────────────────────────────

function buildResult({
  executionState,
  tradeId,
  fillPrice,
  marginRequired,
  marginAvailable,
  projectedFreeMargin,
  leverage,
  notionalUSD,
  executionLog,
  oandaResponse,
  units,
  riskAmount,
  sizing,
  signal,
  entry,
  stopLoss,
  takeProfit,
  score,
  confidence,
}) {
  const tradeHistoryId = recordTrade({
    pair:            signal.pair,
    direction:       signal.direction,
    session:         signal.session || 'Unknown',
    timeframe:       'M15',
    score,
    confidence,
    entryQualityConfidence: signal.entryQualityConfidence ?? null,
    entryTpHitConfidence: signal.tpHitConfidence ?? null,
    entryStrategy: signal.strategy ?? (signal.selectedLogicType === 'v3_pure' ? 'V3' : null),
    actualFillRR: signal.actualFillRR ?? sizing?.riskReward ?? null,
    scoreBreakdown:  signal.scoreBreakdown || {},
    entry,
    stopLoss,
    takeProfit,
    riskReward:      signal.actualFillRR ?? sizing?.riskReward ?? signal.riskReward,
    atrPips:         signal.atrPips   || null,
    trend:           signal.trend     || null,
    mtfAlignment:    signal.mtfAlignment    || null,
    marketStructure: signal.marketStructure || null,
    units,
    riskAmount,
    oandaOrderId:    tradeId,
    // Entry context (2026-05-27 active-trade-mgmt upgrade)
    entryMarketState:             signal.marketState              ?? null,
    entryMarketStateScore:        signal.marketStateScore         ?? null,
    entryCandleStrengthScore:     signal.candleStrengthScore      ?? null,
    entryMtfAlignmentScore:       signal.multiTimeframeAlignmentScore ?? null,
    entryATR:                     signal.atrPips                  ?? null,
    entryExpectedHoldTimeMinutes: signal.expectedHoldTimeMinutes  ?? null,
    entrySelectedLogicType:       signal.selectedLogicType        ?? null,
    entryAssetClass:              signal.assetClass               ?? null,
    entryRiskRewardRatio:         signal.riskRewardRatio          ?? null,
    entrySession:                 signal.session                  ?? null,
    entrySpreadPips:              signal.spreadPips               ?? null,
    originalRecommendedTP:        signal.recommendedTakeProfit    ?? takeProfit,
    originalRecommendedSL:        signal.recommendedStopLoss      ?? stopLoss,
    entryRejectionWarnings:       signal.sizingWarnings           ?? [],
    // Signal Stack V3 — expected-RR feedback inputs (used by calibration)
    expectedRR:                   signal.expectedRR               ?? null,
    expectedRiskPips:             signal.expectedRiskPips         ?? null,
    expectedRewardPips:           signal.expectedRewardPips       ?? null,
    rrTier:                       signal.rrTier                   ?? null,
    rrQualityFactor:              signal.rrQualityFactor          ?? null,
  });

  return {
    success:             true,
    blocked:             false,
    reason:              null,
    executionState,
    tradeId,
    fillPrice,
    notionalUSD,
    marginRequired,
    marginAvailable,
    projectedFreeMargin,
    leverage,
    executionLog,
    oandaResponse,
    units,
    lotSize:             sizing?.lotSize ?? FIXED_LOT_SIZE,
    riskAmount,
    sizing,
    aggressiveRiskWarning: DYNAMIC_RISK_NOTICE,
    tradeHistoryId,
    environment: getEnvironment(),
    isPaperTrading: getEnvironment() !== 'live',
    tpHitConfidence: signal.tpHitConfidence ?? null,
    entryQualityConfidence: signal.entryQualityConfidence ?? null,
    actualFillRR: signal.actualFillRR ?? sizing?.riskReward ?? null,
    postFillTpAdjusted: signal.postFillTpAdjusted === true,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function blocked(reason) {
  console.log(`[TRADE] ✗ BLOCKED — ${reason}`);
  return {
    success: false,
    blocked: true,
    reason,
    executionState: 'REJECTED',
    environment: getEnvironment(),  // always include for dashboard visibility
  };
}

// ─── Close position ───────────────────────────────────────────────────────────

export async function closePosition(instrument) {
  const accountId = getAccountId();
  console.log(`[TRADE] Closing position: ${instrument}`);
  try {
    const response = await oandaPost(
      `/v3/accounts/${accountId}/positions/${instrument}/close`,
      { longUnits: 'ALL', shortUnits: 'ALL' }
    );
    activeTrades.delete(`${instrument}_long`);
    activeTrades.delete(`${instrument}_short`);
    console.log(`[TRADE] ✓ Position closed: ${instrument}`);
    return { success: true, response };
  } catch (err) {
    console.error(`[TRADE] ✗ Close failed for ${instrument}:`, err.message);
    return { success: false, reason: err.message };
  }
}

/**
 * Multi-tenant close helper.
 *
 *   PUT /v3/accounts/{accountId}/trades/{tradeId}/close
 *     body: { units: 'ALL' | String(N) }
 *
 * Closes a specific OANDA trade by tradeId, supporting full or partial.
 * Requires a per-request client (no env-default fallback) — the dashboard
 * close path always runs inside runUserScoped on the internal endpoint.
 *
 * @param {Object} args
 * @param {string} args.tradeId      — OANDA trade id (REQUIRED)
 * @param {string} [args.instrument] — OANDA instrument, used for cleanup +
 *                                     logging. If omitted, the active-trades
 *                                     local lock cache is left untouched.
 * @param {number|string} [args.units]  — units to close. Omitted or 'ALL' →
 *                                        full close. Numeric (positive) → partial.
 * @param {Object} args.client       — per-request OANDA client (REQUIRED)
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   action: 'closed' | 'partial_closed',
 *   instrument: string|null,
 *   tradeId: string,
 *   unitsClosed: number,
 *   brokerOrderId: string|null,
 *   pnl: number|null,
 *   message: string,
 *   raw?: object,
 *   error?: string,
 * }>}
 */
export async function closeBrokerTrade({ tradeId, instrument = null, units, client }) {
  if (!client) {
    throw new Error('closeBrokerTrade: per-request client is required');
  }
  if (!tradeId) {
    throw new Error('closeBrokerTrade: tradeId is required');
  }
  const isFullClose = units == null || String(units).toUpperCase() === 'ALL';
  const body = {
    units: isFullClose ? 'ALL' : String(Math.max(1, Math.floor(Number(units)))),
  };
  console.log(
    `[TRADE_CLOSE] tradeId=${tradeId} instrument=${instrument ?? '?'} ` +
      `units=${body.units} env=${client.environment}`,
  );
  try {
    const response = await client.put(
      `/v3/accounts/${client.accountId}/trades/${tradeId}/close`,
      body,
    );
    // OANDA returns orderFillTransaction OR orderCancelTransaction at the top
    // level. The fill transaction carries the realised PnL on close.
    const fill = response?.orderFillTransaction ?? null;
    const cancel = response?.orderCancelTransaction ?? null;
    if (cancel) {
      const reason = cancel.reason || 'cancelled by broker';
      console.warn(`[TRADE_CLOSE] ✗ cancelled tradeId=${tradeId} reason=${reason}`);
      return {
        ok: false,
        action: isFullClose ? 'closed' : 'partial_closed',
        instrument,
        tradeId,
        unitsClosed: 0,
        brokerOrderId: null,
        pnl: null,
        message: `OANDA cancelled close request: ${reason}`,
        error: reason,
        raw: response,
      };
    }
    const unitsClosedRaw =
      fill?.units != null
        ? fill.units
        : body.units === 'ALL'
          ? 0
          : body.units;
    const unitsClosed = Math.abs(parseFloat(unitsClosedRaw));
    const pnl = fill?.pl != null ? parseFloat(fill.pl) : null;
    const brokerOrderId = fill?.id ?? fill?.tradeID ?? null;
    if (instrument) {
      // Best-effort cleanup of the local lock cache for full closes.
      if (isFullClose) {
        activeTrades.delete(`${instrument}_long`);
        activeTrades.delete(`${instrument}_short`);
      }
    }
    console.log(
      `[TRADE_CLOSE] ✓ tradeId=${tradeId} unitsClosed=${unitsClosed} pnl=${pnl ?? 'n/a'}`,
    );
    return {
      ok: true,
      action: isFullClose ? 'closed' : 'partial_closed',
      instrument,
      tradeId,
      unitsClosed: Number.isFinite(unitsClosed) ? unitsClosed : 0,
      brokerOrderId,
      pnl,
      message: isFullClose
        ? `Trade ${tradeId} closed.`
        : `Closed ${unitsClosed} units of trade ${tradeId}.`,
      raw: response,
    };
  } catch (err) {
    const message = err?.message || String(err);
    console.error(`[TRADE_CLOSE] ✗ tradeId=${tradeId} error=${message}`);
    return {
      ok: false,
      action: isFullClose ? 'closed' : 'partial_closed',
      instrument,
      tradeId,
      unitsClosed: 0,
      brokerOrderId: null,
      pnl: null,
      message: `Close failed: ${message}`,
      error: message,
    };
  }
}

export function getTradeState() {
  return {
    autoTradeEnabled:   AUTO_TRADE_ENABLED,
    dailyTradesCount:   dailyTradeTimestamps.length,
    dailyTradesCap:     dailyTradeCap(),
    dailyLossUSD:       +dailyLossUSD.toFixed(2),
    activeTrades:       Array.from(activeTrades),
    cooldownRemainingMs: Math.max(0, COOLDOWN_MS - (Date.now() - lastTradeTime)),
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
  return hour >= 2 && hour < 14;
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
