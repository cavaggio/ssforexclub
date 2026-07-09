/**
 * server/oandaRiskSizing.js
 *
 * Dynamic per-trade position sizing for OANDA with a fixed 20p / 60p / 1:3
 * price structure.
 *
 *   Every trade — long or short, forex or metals — uses:
 *     - stop loss  = entry ∓ 20 pips
 *     - take profit = entry ± 60 pips
 *     - risk:reward = 1 : 3
 *
 *   The USD risk per trade is dynamic: `computeDynamicTradeRisk` sizes it from
 *   the live account balance and the signal's confidence/score/spread/volatility.
 *   `computeFixedDollarSizing` then converts that dollar target + the 20 pip stop
 *   into units/lots, returning notional + margin + leverage too.
 *
 *   Env knobs (all optional):
 *     FOREX_MIN_RISK_PERCENT          (default 0.5)   risk floor when confidence is just over the threshold
 *     FOREX_MAX_RISK_PERCENT          (default 2.0)   risk ceiling at full conviction
 *     FOREX_CONFIDENCE_FOR_MAX_RISK   (default 80)    confidence at which we use MAX_RISK_PERCENT
 *     FOREX_TARGET_RISK_USD           (legacy)        kept only as a hard upper-bound override
 *
 * NOTE: This module ONLY sizes positions and computes SL/TP prices. It does not
 * alter qualification, scoring, spread filters, session filters, or duplicate
 * protection.
 */

export const RISK_MODE = 'dynamic';

// SL/TP/RR are now per-trade values produced by oandaTradeLifecycle.js.
// `MINIMUM_RISK_REWARD` is retained only as a legacy import target.
export const MINIMUM_RISK_REWARD = 1.5;   // hard floor; lifecycle engine enforces

export const MIN_RISK_PERCENT          = parseFloat(process.env.FOREX_MIN_RISK_PERCENT          || '0.5');
export const MAX_RISK_PERCENT          = parseFloat(process.env.FOREX_MAX_RISK_PERCENT || '1.4');
export const CONFIDENCE_FOR_MAX_RISK   = parseFloat(process.env.FOREX_CONFIDENCE_FOR_MAX_RISK   || '80');

// Legacy hard cap. When set, no single trade can risk more than this absolute USD
// amount even if MAX_RISK_PERCENT × balance is larger. Useful while the account
// is small and you want a belt-and-braces ceiling. 0 means "no override".
export const LEGACY_TARGET_RISK_USD_CAP = parseFloat(process.env.FOREX_TARGET_RISK_USD || '0');

export const DYNAMIC_RISK_NOTICE =
  `Dynamic per-trade sizing — risk % ${MIN_RISK_PERCENT}–${MAX_RISK_PERCENT}% of balance, dynamic SL/TP/hold-window per setup.`;

// Legacy export — older modules import this; keep the symbol so they keep working.
export const AGGRESSIVE_RISK_WARNING = DYNAMIC_RISK_NOTICE;

const FALLBACK_USD_JPY = parseFloat(process.env.FOREX_FALLBACK_USD_JPY || '150');
const FALLBACK_GBP_USD = parseFloat(process.env.FOREX_FALLBACK_GBP_USD || '1.27');
const FALLBACK_EUR_USD = parseFloat(process.env.FOREX_FALLBACK_EUR_USD || '1.08');
const FALLBACK_AUD_USD = parseFloat(process.env.FOREX_FALLBACK_AUD_USD || '0.66');
const FALLBACK_NZD_USD = parseFloat(process.env.FOREX_FALLBACK_NZD_USD || '0.61');

const FALLBACK_LEVERAGE_FOREX  = 50;
const FALLBACK_LEVERAGE_METALS = 20;

// ─── Instrument helpers ───────────────────────────────────────────────────────

export function getPipSize(pair) {
  if (pair.includes('JPY'))                      return 0.01;
  if (pair === 'XAU_USD' || pair === 'XAG_USD')  return 0.01;
  return 0.0001;
}

export function isMetalsPair(pair) {
  return pair === 'XAU_USD' || pair === 'XAG_USD';
}

function approxQuoteToUsd(quote) {
  if (quote === 'USD') return 1;
  if (quote === 'JPY') return 1 / FALLBACK_USD_JPY;
  if (quote === 'GBP') return FALLBACK_GBP_USD;
  if (quote === 'EUR') return FALLBACK_EUR_USD;
  if (quote === 'AUD') return FALLBACK_AUD_USD;
  if (quote === 'NZD') return FALLBACK_NZD_USD;
  return 1; // best-effort fallback for exotic crosses
}

/**
 * USD P&L per 1 unit per 1 pip move.
 *
 *   Metals (XAU_USD, XAG_USD): 1 unit = 1 oz, pip = 0.01 USD     → $0.01 / unit / pip
 *   USD-quote (EUR_USD, …):    1 pip = pipSize USD               → pipSize / unit / pip
 *   USD-base (USD_JPY, …):     1 pip = pipSize in quote currency → pipSize / entryPrice
 *   Cross pairs (EUR_JPY, …):  pipSize in quote → multiply by approx quote→USD rate
 */
export function dollarPerPipPerUnit(pair, entryPrice) {
  const pipSize = getPipSize(pair);

  if (isMetalsPair(pair)) return pipSize;

  const [base, quote] = pair.split('_');
  if (quote === 'USD') return pipSize;
  if (base  === 'USD') {
    if (!entryPrice || entryPrice <= 0) return pipSize / FALLBACK_USD_JPY;
    return pipSize / entryPrice;
  }
  // Cross pair: pip move is in the quote currency — convert to USD.
  return pipSize * approxQuoteToUsd(quote);
}

/**
 * Convert OANDA units → display lot size.
 *   forex:  1 std lot = 100,000 units
 *   gold:   1 std lot = 100     units
 *   silver: 1 std lot = 5,000   units
 */
export function lotsFromUnits(pair, absUnits) {
  if (pair === 'XAU_USD') return absUnits / 100;
  if (pair === 'XAG_USD') return absUnits / 5000;
  return absUnits / 100000;
}

/**
 * Mirror of calculateForexNotionalUSD in oandaTrade.js — keep in sync.
 */
export function notionalUsd(pair, absUnits, entryPrice) {
  if (isMetalsPair(pair)) return absUnits * entryPrice;
  const [base, quote] = pair.split('_');
  if (base  === 'USD') return absUnits;
  if (quote === 'USD') return absUnits * entryPrice;
  return absUnits; // cross pairs
}

export function estimateMargin(pair, absUnits, entryPrice, accountMarginRate) {
  const metals = isMetalsPair(pair);
  const effectiveLeverage = (accountMarginRate > 0)
    ? 1 / accountMarginRate
    : (metals ? FALLBACK_LEVERAGE_METALS : FALLBACK_LEVERAGE_FOREX);
  const notional = notionalUsd(pair, absUnits, entryPrice);
  return {
    estimatedMargin: notional / effectiveLeverage,
    notionalUSD: notional,
    effectiveLeverage,
  };
}

/**
 * Round units to broker-acceptable values.
 *   metals: integer >= 1
 *   forex:  integer >= 1 (OANDA accepts single-unit increments)
 */
function roundUnits(rawUnits) {
  if (!Number.isFinite(rawUnits) || rawUnits <= 0) return 0;
  return Math.max(1, Math.floor(rawUnits));
}

/**
 * Calculate the per-trade USD risk budget from live account state + signal quality.
 *
 *   risk% = lerp(MIN_RISK_PERCENT … MAX_RISK_PERCENT) over confidence ∈ [minConfidence … CONFIDENCE_FOR_MAX_RISK]
 *
 * Modifiers applied on top of the interpolated base %:
 *   - score (0–20):     ×0.85 below 12, ×1.0 12–13, ×1.1 14–17, ×1.2 ≥18
 *   - wide spread:      ×0.85 when spreadPips > 50% of pair's maxSpreadPips
 *   - low volatility:   ×0.85 when volatilityState === 'low' (TP less likely to print)
 *
 * The result is clamped back into [MIN_RISK_PERCENT, MAX_RISK_PERCENT] and converted
 * to USD via accountBalanceUSD. LEGACY_TARGET_RISK_USD_CAP, if set, caps the USD result.
 *
 * If the trade should not be sized (no balance, sub-threshold confidence), returns
 * { allowed:false } so the caller can route the rejection through its normal path.
 */
export function computeDynamicTradeRisk({
  accountBalanceUSD,
  confidence,
  score,
  minConfidence = 0,
  spreadPips = null,
  maxSpreadPips = null,
  volatilityState = null,
}) {
  if (!accountBalanceUSD || !Number.isFinite(accountBalanceUSD) || accountBalanceUSD <= 0) {
    return { allowed: false, reason: 'no_balance', riskPercent: 0, riskUSD: 0 };
  }
  if (!Number.isFinite(confidence) || confidence < minConfidence) {
    return { allowed: false, reason: 'below_min_confidence', riskPercent: 0, riskUSD: 0 };
  }

  const confidenceRange = Math.max(1, CONFIDENCE_FOR_MAX_RISK - minConfidence);
  const t = Math.min(1, Math.max(0, (confidence - minConfidence) / confidenceRange));
  let pct = MIN_RISK_PERCENT + t * (MAX_RISK_PERCENT - MIN_RISK_PERCENT);

  const modifiers = [];
  if (Number.isFinite(score)) {
    const scoreMult = score >= 18 ? 1.2 : score >= 14 ? 1.1 : score >= 12 ? 1.0 : 0.85;
    if (scoreMult !== 1.0) modifiers.push(`score×${scoreMult}`);
    pct *= scoreMult;
  }
  if (
    Number.isFinite(spreadPips) &&
    Number.isFinite(maxSpreadPips) &&
    maxSpreadPips > 0 &&
    spreadPips > maxSpreadPips * 0.5
  ) {
    pct *= 0.85;
    modifiers.push('wide-spread×0.85');
  }
  if (volatilityState === 'low') {
    pct *= 0.85;
    modifiers.push('low-vol×0.85');
  }

  pct = Math.max(MIN_RISK_PERCENT, Math.min(MAX_RISK_PERCENT, pct));

  let riskUSD = +(accountBalanceUSD * (pct / 100)).toFixed(2);
  let capped = false;
  if (LEGACY_TARGET_RISK_USD_CAP > 0 && riskUSD > LEGACY_TARGET_RISK_USD_CAP) {
    riskUSD = LEGACY_TARGET_RISK_USD_CAP;
    capped = true;
    modifiers.push(`legacy-cap@$${LEGACY_TARGET_RISK_USD_CAP}`);
  }

  return {
    allowed: true,
    riskPercent: +pct.toFixed(2),
    riskUSD,
    cappedToLegacy: capped,
    factors: {
      confidence,
      score,
      spreadPips,
      maxSpreadPips,
      volatilityState,
      confidenceInterpolant: +t.toFixed(3),
      modifiers,
    },
  };
}

/**
 * Core dollar-targeted sizing routine.
 *
 * Caller supplies all four dynamic price values (computed by oandaTradeLifecycle):
 *   stopLossPips, stopLossPrice, takeProfitPips, takeProfitPrice
 *
 *   units = targetRiskUSD / (stopLossPips × dollarPerPipPerUnit(pair, entry))
 *
 * `targetRiskUSD` comes from `computeDynamicTradeRisk` (live balance + quality).
 */
export function computeFixedDollarSizing({
  pair,
  direction,
  entryPrice,
  targetRiskUSD,
  stopLossPips,
  stopLossPrice,
  takeProfitPips,
  takeProfitPrice,
  accountMarginRate = 0,
  accountBalanceUSD = null,
}) {
  if (!stopLossPips || stopLossPips <= 0) {
    throw new Error('computeFixedDollarSizing: stopLossPips is required and must be > 0');
  }
  if (!takeProfitPips || takeProfitPips <= 0) {
    throw new Error('computeFixedDollarSizing: takeProfitPips is required and must be > 0');
  }

  const riskReward = +(takeProfitPips / stopLossPips).toFixed(2);

  const pipUsdPerUnit         = dollarPerPipPerUnit(pair, entryPrice);
  const pipUsdPerStandardLot  = pipUsdPerUnit * (isMetalsPair(pair)
    ? (pair === 'XAU_USD' ? 100 : 5000)
    : 100000);

  const riskPerUnit           = pipUsdPerUnit * stopLossPips;
  const rawUnits              = riskPerUnit > 0 ? targetRiskUSD / riskPerUnit : 0;
  const tradeUnits            = roundUnits(rawUnits);
  const lotSize               = +lotsFromUnits(pair, tradeUnits).toFixed(4);

  const actualRiskUSD         = +(tradeUnits * riskPerUnit).toFixed(2);
  const estimatedRewardUSD    = +(actualRiskUSD * riskReward).toFixed(2);

  const signedUnits           = direction === 'short' ? -tradeUnits : tradeUnits;

  const { estimatedMargin, notionalUSD, effectiveLeverage } =
    estimateMargin(pair, Math.abs(signedUnits), entryPrice, accountMarginRate);

  const warnings = [];
  if (accountBalanceUSD !== null && targetRiskUSD > accountBalanceUSD * 0.05) {
    warnings.push(`Target risk $${targetRiskUSD} is >5% of $${accountBalanceUSD.toFixed(2)} balance — aggressive.`);
  }

  return {
    riskMode: RISK_MODE,
    targetRiskUSD,
    targetRewardUSD: +(targetRiskUSD * riskReward).toFixed(2),
    minimumRiskReward: riskReward,

    stopLossPips,
    takeProfitPips,
    stopLoss: stopLossPrice,
    takeProfit: takeProfitPrice,
    riskReward,

    rawUnits: +rawUnits.toFixed(2),
    tradeUnits,
    signedUnits,
    lotSize,
    pipValuePerStandardLot: +pipUsdPerStandardLot.toFixed(4),

    actualRiskUSD,
    estimatedRewardUSD,

    notionalUSD: +notionalUSD.toFixed(2),
    estimatedMarginRequired: +estimatedMargin.toFixed(2),
    effectiveLeverage: +effectiveLeverage.toFixed(1),

    warnings,
  };
}
