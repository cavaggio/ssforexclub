import { getPipSize } from './pipMath.js';

const finite = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const priceDecimalsFor = (pair) => {
  const normalized = String(pair || '').toUpperCase();
  if (normalized === 'XAU_USD' || normalized === 'XAG_USD') return 2;
  return normalized.includes('JPY') ? 3 : 5;
};

/**
 * Preserve the configured minimum R:R when the fresh executable bid/ask moves a
 * scanner-qualified 1.50R setup a few tenths of a pip before submission.
 *
 * This is deliberately bounded: the scanner setup must already satisfy the
 * floor, the fresh shortfall must be small, and the required TP extension must
 * remain within a tight pip cap. Larger price movement is still rejected.
 */
export function maybeRebaseIctTarget({
  pair,
  direction,
  executablePrice,
  stopLoss,
  currentTarget,
  scannerRR,
  executableRR,
  minimumRR = 1.5,
  maxShortfallR = 0.10,
  maxExtensionPips = 2,
} = {}) {
  const entry = finite(executablePrice);
  const stop = finite(stopLoss);
  const target = finite(currentTarget);
  const scanned = finite(scannerRR, 0);
  const quoted = finite(executableRR, 0);
  const floor = Math.max(1.5, finite(minimumRR, 1.5));
  const shortfallLimit = Math.max(0, finite(maxShortfallR, 0.10));
  const extensionLimit = Math.max(0, finite(maxExtensionPips, 2));
  const isLong = direction === 'long' || direction === 'buy';
  const isShort = direction === 'short' || direction === 'sell';

  const base = {
    adjusted: false,
    targetProfit: target,
    originalTarget: target,
    scannerRR: scanned,
    executableRR: quoted,
    minimumRR: floor,
    shortfallR: Math.max(0, floor - quoted),
    extensionPips: 0,
  };

  if ((!isLong && !isShort) || ![entry, stop, target].every(Number.isFinite)) {
    return { ...base, reason: 'invalid_inputs' };
  }
  const geometryValid = isLong
    ? stop < entry && target > entry
    : stop > entry && target < entry;
  if (!geometryValid) return { ...base, reason: 'invalid_geometry' };
  if (scanned < floor) return { ...base, reason: 'scanner_rr_below_floor' };
  if (quoted >= floor) return { ...base, reason: 'rebase_not_needed' };
  if (!(quoted > 0) || floor - quoted > shortfallLimit) {
    return { ...base, reason: 'rr_shortfall_exceeds_tolerance' };
  }

  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return { ...base, reason: 'invalid_risk_distance' };

  const dp = priceDecimalsFor(pair);
  const tick = 10 ** (-dp);
  const rawTarget = isLong
    ? entry + risk * floor
    : entry - risk * floor;
  const scaled = rawTarget / tick;
  const outwardTicks = isLong
    ? Math.ceil(scaled - 1e-9)
    : Math.floor(scaled + 1e-9);
  const rebasedTarget = Number((outwardTicks * tick).toFixed(dp));
  const pip = getPipSize(pair);
  const extensionPips = pip > 0 ? Math.abs(rebasedTarget - target) / pip : Infinity;
  if (!Number.isFinite(extensionPips) || extensionPips > extensionLimit) {
    return {
      ...base,
      extensionPips: Number.isFinite(extensionPips) ? +extensionPips.toFixed(2) : null,
      reason: 'target_extension_exceeds_cap',
    };
  }

  const rebasedReward = Math.abs(rebasedTarget - entry);
  const rebasedRR = rebasedReward / risk;
  if (rebasedRR + 1e-9 < floor) {
    return { ...base, reason: 'rebased_rr_below_floor' };
  }

  return {
    ...base,
    adjusted: true,
    targetProfit: rebasedTarget,
    rebasedRR: +rebasedRR.toFixed(2),
    extensionPips: +extensionPips.toFixed(2),
    reason: 'fresh_quote_minimum_rr_preserved',
  };
}
