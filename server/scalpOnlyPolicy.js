/**
 * Central scalp-only strategy policy.
 *
 * All scanners may still use higher timeframes as directional context, but every
 * qualified/executable order must be a short-duration scalp with confidence >=75%.
 */

export const HARD_SCALP_CONFIDENCE_FLOOR = 75;

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

export function scalpMinConfidence() {
  // One authoritative floor across ICT, PPR and V3. Stale environment values
  // must not silently restore the previous 80/85/90 percent thresholds.
  return HARD_SCALP_CONFIDENCE_FLOOR;
}

export function scalpMaxHoldMinutes() {
  return Math.max(15, envNumber('SCALP_MAX_HOLD_MINUTES', 120));
}

export function scalpMaxTpAtrMultiple() {
  return Math.max(1, envNumber('SCALP_MAX_TP_ATR_MULTIPLE', 2.0));
}

export function scalpMinRR() {
  return Math.max(1.5, envNumber('FOREX_MIN_EXECUTABLE_RR', 1.5));
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

function fallbackMaxTpPips(pair = '') {
  if (pair === 'XAU_USD' || pair === 'XAG_USD') {
    return envNumber('SCALP_MAX_TP_PIPS_METALS', 300);
  }
  if (String(pair).includes('JPY')) {
    return envNumber('SCALP_MAX_TP_PIPS_JPY', 50);
  }
  return envNumber('SCALP_MAX_TP_PIPS_FOREX', 40);
}

export function explicitTradeStyle(signal = {}) {
  return [
    signal.tradeStyle,
    signal.tradeDuration,
    signal.timeframeEstimate,
    signal.holdingStyle,
    signal.strategyType,
    signal.mode,
  ]
    .filter(Boolean)
    .join(' ')
    .trim();
}

export function isExplicitSwingSignal(signal = {}) {
  return /\bswing\b/i.test(explicitTradeStyle(signal));
}

export function applyScalpMetadata(signal = {}) {
  return {
    ...signal,
    tradeStyle: 'SCALP',
    tradeDuration: 'Scalp',
    timeframeEstimate: 'Scalp',
    scalpOnly: true,
  };
}

/**
 * Convert otherwise-valid SL/TP geometry to a scalp-sized lifecycle.
 *
 * - TP is capped at the smaller of the configured absolute pip cap and ATR cap.
 * - The cap may never reduce the order below the configured minimum R:R.
 * - If the stop is too wide to preserve minimum R:R inside the scalp target cap,
 *   the candidate is rejected instead of becoming a swing trade.
 * - Hold windows are capped at SCALP_MAX_HOLD_MINUTES (default 120).
 */
export function normalizeScalpLifecycle({
  pair,
  direction,
  entryPrice,
  atrPips = null,
  lifecycle = null,
} = {}) {
  if (!lifecycle?.sl || !lifecycle?.tp) {
    return { allowed: false, reason: 'Scalp-only reject: lifecycle SL/TP is missing.' };
  }

  const entry = Number(entryPrice);
  const stopLossPips = Number(lifecycle.sl.stopLossPips);
  const currentTpPips = Number(lifecycle.tp.takeProfitPips);

  if (
    !Number.isFinite(entry) ||
    !Number.isFinite(stopLossPips) ||
    stopLossPips <= 0 ||
    !Number.isFinite(currentTpPips) ||
    currentTpPips <= 0
  ) {
    return { allowed: false, reason: 'Scalp-only reject: invalid lifecycle geometry.' };
  }

  const minRR = scalpMinRR();
  const minimumTpPips = Math.ceil(stopLossPips * minRR);
  const absoluteCap = fallbackMaxTpPips(pair);
  const atrCap =
    Number.isFinite(Number(atrPips)) && Number(atrPips) > 0
      ? Math.max(1, Math.floor(Number(atrPips) * scalpMaxTpAtrMultiple()))
      : absoluteCap;
  const scalpTpCap = Math.min(absoluteCap, atrCap);

  if (minimumTpPips > scalpTpCap) {
    return {
      allowed: false,
      reason:
        `Scalp-only reject: ${stopLossPips}p stop needs at least ${minimumTpPips}p TP ` +
        `for ${minRR}R, above scalp cap ${scalpTpCap}p.`,
      stopLossPips,
      minimumTpPips,
      scalpTpCap,
    };
  }

  const takeProfitPips = Math.max(
    minimumTpPips,
    Math.min(Math.round(currentTpPips), scalpTpCap),
  );
  const pipSize = pipSizeFor(pair);
  const precision = pricePrecisionFor(pair);
  const takeProfitPrice =
    direction === 'long'
      ? Number((entry + takeProfitPips * pipSize).toFixed(precision))
      : Number((entry - takeProfitPips * pipSize).toFixed(precision));

  const maxHold = scalpMaxHoldMinutes();
  const existingMin = Number(lifecycle?.hold?.minMinutes);
  const existingMax = Number(lifecycle?.hold?.maxMinutes);
  const minMinutes = Math.min(
    maxHold,
    Number.isFinite(existingMin) && existingMin > 0 ? existingMin : 15,
  );
  const maxMinutes = Math.max(
    minMinutes,
    Math.min(
      maxHold,
      Number.isFinite(existingMax) && existingMax > 0 ? existingMax : maxHold,
    ),
  );

  const normalized = {
    ...lifecycle,
    allowed: true,
    strategy: 'SCALP',
    tradeStyle: 'SCALP',
    scalpOnly: true,
    sl: {
      ...lifecycle.sl,
      stopLossPips,
    },
    tp: {
      ...lifecycle.tp,
      allowed: true,
      takeProfitPips,
      takeProfitPrice,
      riskReward: Number((takeProfitPips / stopLossPips).toFixed(2)),
      targetReason:
        `${lifecycle.tp.targetReason || 'structure target'} ` +
        `[scalp-only cap=${scalpTpCap}p]`,
    },
    hold: {
      ...(lifecycle.hold || {}),
      minMinutes,
      maxMinutes,
      strategy: 'SCALP',
      timeToTPReason:
        `${lifecycle?.hold?.timeToTPReason || 'scalp lifecycle'} ` +
        `[max hold ${maxHold}m]`,
    },
    riskRewardRatio: Number((takeProfitPips / stopLossPips).toFixed(2)),
    expectedHoldTimeMinutes: Math.round((minMinutes + maxMinutes) / 2),
  };

  return {
    allowed: true,
    lifecycle: normalized,
    takeProfitPips,
    takeProfitPrice,
    riskReward: normalized.riskRewardRatio,
    scalpTpCap,
  };
}
