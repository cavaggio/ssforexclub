/**
 * Central scalp-only strategy policy.
 *
 * All scanners may still use higher timeframes as directional context, but every
 * qualified/executable order uses the fixed 10-pip SL / 15-pip TP geometry.
 */

export const HARD_SCALP_CONFIDENCE_FLOOR = 75;
export const FIXED_STOP_LOSS_PIPS = 10;
export const FIXED_TAKE_PROFIT_PIPS = 15;
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
 * Authoritative fixed scalp lifecycle: 10-pip SL, 15-pip TP, 1.50R.
 * Structure-derived levels cannot override executable risk geometry.
 */
export function normalizeScalpLifecycle({ pair, direction, entryPrice, lifecycle = null } = {}) {
  if (!lifecycle?.sl || !lifecycle?.tp) return { allowed: false, reason: 'Scalp-only reject: lifecycle SL/TP is missing.' };

  const entry = Number(entryPrice);
  if (!Number.isFinite(entry)) return { allowed: false, reason: 'Scalp-only reject: invalid entry price.' };

  const pipSize = pipSizeFor(pair);
  const precision = pricePrecisionFor(pair);
  const stopLossPips = FIXED_STOP_LOSS_PIPS;
  const takeProfitPips = FIXED_TAKE_PROFIT_PIPS;
  const stopLossPrice = direction === 'long'
    ? Number((entry - stopLossPips * pipSize).toFixed(precision))
    : Number((entry + stopLossPips * pipSize).toFixed(precision));
  const takeProfitPrice = direction === 'long'
    ? Number((entry + takeProfitPips * pipSize).toFixed(precision))
    : Number((entry - takeProfitPips * pipSize).toFixed(precision));

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
      riskReward: FIXED_SCALP_RR,
      targetReason: 'fixed 15-pip first profit milestone',
    },
    hold: {
      ...(lifecycle.hold || {}),
      minMinutes,
      maxMinutes,
      strategy: 'SCALP',
      timeToTPReason: `${lifecycle?.hold?.timeToTPReason || 'fixed scalp lifecycle'} [fixed 15p TP]`,
    },
    riskRewardRatio: FIXED_SCALP_RR,
    expectedHoldTimeMinutes: Math.round((minMinutes + maxMinutes) / 2),
  };

  return { allowed: true, lifecycle: normalized, stopLossPips, stopLossPrice, takeProfitPips, takeProfitPrice, riskReward: FIXED_SCALP_RR, scalpTpCap: FIXED_TAKE_PROFIT_PIPS };
}
