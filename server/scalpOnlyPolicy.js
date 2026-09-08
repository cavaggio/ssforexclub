/**
 * Central scalp-only strategy policy.
 *
 * All scanners may still use higher timeframes as directional context, but every
 * qualified/executable order uses the fixed 10-pip SL with an 80/20 profit plan:
 * 80% at +15 pips, remaining 20% at +18 pips after breakeven protection.
 */

export const HARD_SCALP_CONFIDENCE_FLOOR = 75;
export const FIXED_STOP_LOSS_PIPS = 10;
export const FIXED_TAKE_PROFIT_PIPS = 15;
export const FIRST_PARTIAL_PROFIT_PIPS = 15;
export const FIRST_PARTIAL_PERCENT = 80;
export const FINAL_TAKE_PROFIT_PIPS = 18;
export const FINAL_PARTIAL_PERCENT = 20;
export const FIXED_SCALP_RR = 1.5;

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

export function scalpMinConfidence() {
  return HARD_SCALP_CONFIDENCE_FLOOR;
}

export function scalpMaxHoldMinutes() {
  return Math.max(15, envNumber('SCALP_MAX_HOLD_MINUTES', 120));
}

export function scalpMaxTpAtrMultiple() {
  return Math.max(1, envNumber('SCALP_MAX_TP_ATR_MULTIPLE', 2.0));
}

export function scalpMinRR() {
  return FIXED_SCALP_RR;
}

function pipSizeFor(pair = '') {
  if (String(pair).includes('JPY')) return 0.01;
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return 0.01;
  return 0.0001;
}

function pricePrecisionFor(pair = '') {
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return 2;
  if (String(pair).includes('JPY')) return 3;
  return 5;
}

export function explicitTradeStyle(signal = {}) {
  return [signal.tradeStyle, signal.tradeDuration, signal.timeframeEstimate, signal.holdingStyle, signal.strategyType, signal.mode]
    .filter(Boolean).join(' ').trim();
}

export function isExplicitSwingSignal(signal = {}) {
  return /\bswing\b/i.test(explicitTradeStyle(signal));
}

export function applyScalpMetadata(signal = {}) {
  return { ...signal, tradeStyle: 'SCALP', tradeDuration: 'Scalp', timeframeEstimate: 'Scalp', scalpOnly: true };
}

/**
 * Authoritative fixed scalp lifecycle: 10-pip SL, 15-pip first milestone,
 * 80% first partial, 20% runner to the 18-pip final milestone, 1.50R minimum.
 * Structure-derived levels cannot override executable risk geometry.
 */
export function normalizeScalpLifecycle({ pair, direction, entryPrice, lifecycle = null } = {}) {
  if (!lifecycle?.sl || !lifecycle?.tp) return { allowed: false, reason: 'Scalp-only reject: lifecycle SL/TP is missing.' };

  const entry = Number(entryPrice);
  if (!Number.isFinite(entry)) return { allowed: false, reason: 'Scalp-only reject: invalid entry price.' };

  const pipSize = pipSizeFor(pair);
  const precision = pricePrecisionFor(pair);
  const stopLossPips = FIXED_STOP_LOSS_PIPS;
  const takeProfitPips = FIRST_PARTIAL_PROFIT_PIPS;
  const stopLossPrice = direction === 'long'
    ? Number((entry - stopLossPips * pipSize).toFixed(precision))
    : Number((entry + stopLossPips * pipSize).toFixed(precision));
  const takeProfitPrice = direction === 'long'
    ? Number((entry + takeProfitPips * pipSize).toFixed(precision))
    : Number((entry - takeProfitPips * pipSize).toFixed(precision));
  const finalTakeProfitPrice = direction === 'long'
    ? Number((entry + FINAL_TAKE_PROFIT_PIPS * pipSize).toFixed(precision))
    : Number((entry - FINAL_TAKE_PROFIT_PIPS * pipSize).toFixed(precision));

  const maxHold = scalpMaxHoldMinutes();
  const existingMin = Number(lifecycle?.hold?.minMinutes);
  const existingMax = Number(lifecycle?.hold?.maxMinutes);
  const minMinutes = Math.min(maxHold, Number.isFinite(existingMin) && existingMin > 0 ? existingMin : 15);
  const maxMinutes = Math.max(minMinutes, Math.min(maxHold, Number.isFinite(existingMax) && existingMax > 0 ? existingMax : maxHold));

  const normalized = {
    ...lifecycle,
    allowed: true,
    strategy: 'SCALP',
    tradeStyle: 'SCALP',
    scalpOnly: true,
    sl: {
      ...lifecycle.sl,
      allowed: true,
      stopLossPips,
      stopLossPrice,
      riskReward: FIXED_SCALP_RR,
      targetReason: 'fixed 10-pip protective stop',
    },
    tp: {
      ...lifecycle.tp,
      allowed: true,
      takeProfitPips,
      takeProfitPrice,
      finalTakeProfitPips: FINAL_TAKE_PROFIT_PIPS,
      finalTakeProfitPrice,
      firstPartialPercent: FIRST_PARTIAL_PERCENT,
      finalPartialPercent: FINAL_PARTIAL_PERCENT,
      riskReward: FIXED_SCALP_RR,
      targetReason: 'fixed 15-pip first profit milestone; 80% partial, 20% runner to 18 pips',
    },
    hold: {
      ...(lifecycle.hold || {}),
      minMinutes,
      maxMinutes,
      strategy: 'SCALP',
      timeToTPReason: `${lifecycle?.hold?.timeToTPReason || 'fixed scalp lifecycle'} [15p first milestone / 18p final milestone]`,
    },
    riskRewardRatio: FIXED_SCALP_RR,
    expectedHoldTimeMinutes: Math.round((minMinutes + maxMinutes) / 2),
  };

  return {
    allowed: true,
    lifecycle: normalized,
    stopLossPips,
    stopLossPrice,
    takeProfitPips,
    takeProfitPrice,
    finalTakeProfitPips: FINAL_TAKE_PROFIT_PIPS,
    finalTakeProfitPrice,
    firstPartialPercent: FIRST_PARTIAL_PERCENT,
    finalPartialPercent: FINAL_PARTIAL_PERCENT,
    riskReward: FIXED_SCALP_RR,
    scalpTpCap: FINAL_TAKE_PROFIT_PIPS,
  };
}
