/**
 * Primary timeframe alignment policy.
 *
 * HARD GATE:
 *   Daily + H4 + M15 must score at least 67/100 for the intended direction.
 *   This is a 2-of-3 confirmation rule. One opposing primary timeframe is
 *   diagnostic context and is not a separate rejection.
 *
 * SOFT CONTEXT ONLY:
 *   H1 + M30 + M5 may warn/conflict, but they do not define the primary score.
 */

export const PRIMARY_ALIGNMENT_TIMEFRAMES = ['daily', 'h4', 'm15'];
export const CONTEXT_ALIGNMENT_TIMEFRAMES = ['h1', 'm30', 'm5'];
export const PRIMARY_ALIGNMENT_MIN_SCORE = 67;

function norm(value) {
  const s = String(value || '').trim().toLowerCase();
  if (['bull', 'bullish', 'buy', 'long', 'up'].includes(s)) return 'bullish';
  if (['bear', 'bearish', 'sell', 'short', 'down'].includes(s)) return 'bearish';
  if (['neutral', 'flat', 'range', 'ranging', 'mixed', 'none'].includes(s)) return 'neutral';
  return s || null;
}

function wantBias(direction) {
  const s = String(direction || '').trim().toLowerCase();
  if (['buy', 'long', 'bullish'].includes(s)) return 'bullish';
  if (['sell', 'short', 'bearish'].includes(s)) return 'bearish';
  return null;
}

function readTfBias(source, tf) {
  const aliases = {
    daily: ['daily', 'd', 'd1', 'day'],
    h4: ['h4', 'fourHour', 'four_hour', 'fourHourBias', 'h4Bias'],
    h1: ['h1', 'oneHour', 'one_hour', 'oneHourBias', 'h1Bias'],
    m30: ['m30', 'thirtyMin', 'thirty_min', 'm30Bias'],
    m15: ['m15', 'fifteenMin', 'fifteen_min', 'm15Bias'],
    m5: ['m5', 'fiveMin', 'five_min', 'm5Bias'],
  }[tf] || [tf];

  for (const key of aliases) {
    const value =
      source?.[key]?.bias ??
      source?.[key]?.direction ??
      source?.[key]?.trend ??
      source?.[key];
    const normalized = norm(value);
    if (normalized) return normalized;
  }
  return null;
}

export function extractTimeframeBiases(input = {}) {
  const source =
    input.timeframes ||
    input.timeframeBiases ||
    input.multiTimeframe ||
    input.mtf ||
    input.alignment ||
    input.biases ||
    input;

  const out = {};
  for (const tf of [...PRIMARY_ALIGNMENT_TIMEFRAMES, ...CONTEXT_ALIGNMENT_TIMEFRAMES]) {
    out[tf] = readTfBias(source, tf);
  }
  return out;
}

export function evaluatePrimaryTimeframeAlignment(input = {}, direction) {
  const expected = wantBias(direction || input.direction || input.signal || input.side);
  const biases = extractTimeframeBiases(input);

  if (!expected) {
    return {
      passed: false,
      expected,
      score: 0,
      biases,
      reason: 'No executable direction available for primary timeframe alignment.',
    };
  }

  const aligned = PRIMARY_ALIGNMENT_TIMEFRAMES.filter((tf) => biases[tf] === expected);
  const score = Math.round((aligned.length / PRIMARY_ALIGNMENT_TIMEFRAMES.length) * 100);
  const failures = PRIMARY_ALIGNMENT_TIMEFRAMES.filter((tf) => biases[tf] !== expected);
  const primaryConflicts = failures.filter((tf) => biases[tf] && biases[tf] !== 'neutral');
  const contextConflicts = CONTEXT_ALIGNMENT_TIMEFRAMES.filter((tf) => {
    const bias = biases[tf];
    return bias && bias !== 'neutral' && bias !== expected;
  });
  const passed = score >= PRIMARY_ALIGNMENT_MIN_SCORE;

  return {
    passed,
    expected,
    score,
    minimumScore: PRIMARY_ALIGNMENT_MIN_SCORE,
    primaryTimeframes: PRIMARY_ALIGNMENT_TIMEFRAMES,
    contextTimeframes: CONTEXT_ALIGNMENT_TIMEFRAMES,
    biases,
    aligned,
    failures,
    primaryConflicts,
    contextConflicts,
    reason: passed
      ? primaryConflicts.length
        ? `Primary timeframe alignment passed at ${score}/100; opposing primary context: ${primaryConflicts.join(', ')}.`
        : `Primary timeframe alignment passed at ${score}/100.`
      : `Primary timeframe alignment failed: Daily + H4 + M15 score ${score}/100 < ${PRIMARY_ALIGNMENT_MIN_SCORE}/100.`,
  };
}

export function shouldHardRejectForTimeframes(input = {}, direction) {
  return !evaluatePrimaryTimeframeAlignment(input, direction).passed;
}
