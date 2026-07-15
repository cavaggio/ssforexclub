export const PRIMARY_DIRECTION_DISPLAY_POLICY_VERSION =
  'primary-direction-majority-2026-07-15';

const PRIMARY_TIMEFRAMES = ['daily', 'h4', 'm15'];
const DISPLAY_ARRAY_KEYS = [
  'qualified',
  'rejected',
  'nearQualified',
  'watchCandidates',
  'hotWatch',
  'hotWatchCandidates',
  'v3PrimaryPassedContext',
];

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeBias(value) {
  const text = String(value || '').trim().toLowerCase();
  if (['bull', 'bullish', 'buy', 'long', 'up'].includes(text)) return 'bullish';
  if (['bear', 'bearish', 'sell', 'short', 'down'].includes(text)) return 'bearish';
  if (['neutral', 'flat', 'range', 'ranging', 'mixed', 'none'].includes(text)) return 'neutral';
  return null;
}

function normalizeDirection(value) {
  const bias = normalizeBias(value);
  if (bias === 'bullish') return 'long';
  if (bias === 'bearish') return 'short';
  return null;
}

function readPrimaryTimeframes(signal = {}) {
  const alignment = record(signal.alignment);
  const timeframes = record(alignment.timeframes);
  const macro = record(signal.macro);
  const momentum = record(signal.momentum);

  return {
    daily: normalizeBias(timeframes.daily ?? macro.dailyTrend),
    h4: normalizeBias(timeframes.h4 ?? macro.h4Trend),
    m15: normalizeBias(timeframes.m15 ?? momentum.m15Trend),
  };
}

function primaryMajority(timeframes) {
  const values = PRIMARY_TIMEFRAMES.map((timeframe) => timeframes[timeframe]);
  const bullish = values.filter((value) => value === 'bullish').length;
  const bearish = values.filter((value) => value === 'bearish').length;

  if (bullish >= 2) return { bias: 'bullish', count: bullish };
  if (bearish >= 2) return { bias: 'bearish', count: bearish };
  return null;
}

/**
 * Correct dashboard-only direction before the V3 display normalizer calculates
 * Daily/H4/M15 alignment. The primary majority is authoritative. Legacy signal,
 * V3-shadow, and momentum directions remain recorded as diagnostics but cannot
 * force the alignment score to be calculated against the wrong side.
 *
 * This function is presentation-only. It does not touch Railway execution,
 * qualification, sizing, broker routing, or Auto AI state.
 */
export function applyPrimaryDirectionToSignal(signal = {}) {
  if (!signal || typeof signal !== 'object' || Array.isArray(signal)) return signal;

  const timeframes = readPrimaryTimeframes(signal);
  const majority = primaryMajority(timeframes);
  if (!majority) return signal;

  const correctedDirection = majority.bias === 'bullish' ? 'long' : 'short';
  const originalDirections = {
    signal: normalizeDirection(signal.direction),
    v3: normalizeDirection(record(signal.v3).direction),
    momentum: normalizeDirection(record(signal.momentum).executionSignal),
  };
  const conflictingSources = Object.entries(originalDirections)
    .filter(([, direction]) => direction && direction !== correctedDirection)
    .map(([source]) => source);

  return {
    ...signal,
    direction: correctedDirection,
    primaryDirectionDisplay: {
      policyVersion: PRIMARY_DIRECTION_DISPLAY_POLICY_VERSION,
      source: 'Daily/H4/M15 majority',
      direction: correctedDirection,
      bias: majority.bias,
      alignedCount: majority.count,
      score: majority.count === 3 ? 100 : 67,
      timeframes,
      originalDirections,
      conflictingSources,
      corrected: conflictingSources.length > 0,
    },
  };
}

export function applyPrimaryDirectionDisplayPolicy(scan = {}) {
  const source = record(scan);
  const corrected = { ...source };

  for (const key of DISPLAY_ARRAY_KEYS) {
    if (Array.isArray(source[key])) {
      corrected[key] = source[key].map(applyPrimaryDirectionToSignal);
    }
  }

  corrected.meta = {
    ...record(source.meta),
    primaryDirectionDisplayPolicy: PRIMARY_DIRECTION_DISPLAY_POLICY_VERSION,
    primaryDirectionAuthority: 'Daily/H4/M15 majority before legacy direction',
  };

  return corrected;
}
