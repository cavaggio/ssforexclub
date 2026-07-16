/**
 * Primary timeframe alignment policy.
 *
 * HARD GATE:
 *   Daily + H4 + M15 are the only directional decision timeframes.
 *   Daily and H4 must both align with the intended direction. That hard pair scores 67/100; aligned M15 raises the score to 100/100.
 *
 * SOFT CONTEXT ONLY:
 *   H1 + M30 + M5 may warn/conflict, but they must not reject an otherwise valid trade.
 */

export const PRIMARY_ALIGNMENT_TIMEFRAMES = ['daily', 'h4', 'm15'];
export const CONTEXT_ALIGNMENT_TIMEFRAMES = ['h1', 'm30', 'm5'];
export const PRIMARY_ALIGNMENT_MIN_SCORE = 67;
export const PRIMARY_ALIGNMENT_POLICY_VERSION = 'v3-primary-daily-h4-hard-2026-07-16';

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

    const n = norm(value);
    if (n) return n;
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

function majorityBias(biases) {
  const primary = PRIMARY_ALIGNMENT_TIMEFRAMES.map((tf) => biases[tf]);
  const bullish = primary.filter((bias) => bias === 'bullish').length;
  const bearish = primary.filter((bias) => bias === 'bearish').length;

  if (bullish >= 2) return 'bullish';
  if (bearish >= 2) return 'bearish';
  return null;
}

export function evaluatePrimaryTimeframeAlignment(input = {}, direction) {
  const biases = extractTimeframeBiases(input);
  const explicitExpected = wantBias(direction || input.direction || input.signal || input.side);
  const expected = explicitExpected || majorityBias(biases);
  const missingTimeframes = PRIMARY_ALIGNMENT_TIMEFRAMES.filter((tf) => !biases[tf]);

  if (!expected) {
    return {
      passed: false,
      score: 0,
      expected,
      explicitDirection: Boolean(explicitExpected),
      policyVersion: PRIMARY_ALIGNMENT_POLICY_VERSION,
      minimumScore: PRIMARY_ALIGNMENT_MIN_SCORE,
      biases,
      alignedTimeframes: [],
      opposingTimeframes: [],
      neutralTimeframes: PRIMARY_ALIGNMENT_TIMEFRAMES.filter((tf) => biases[tf] === 'neutral'),
      missingTimeframes,
      failures: [...PRIMARY_ALIGNMENT_TIMEFRAMES],
      contextConflicts: [],
      reason: 'No executable two-of-three Daily/H4/M15 direction is available.',
    };
  }

  // Missing candle classifications fail closed rather than manufacturing a score.
  if (missingTimeframes.length > 0) {
    return {
      passed: false,
      score: 0,
      expected,
      explicitDirection: Boolean(explicitExpected),
      policyVersion: PRIMARY_ALIGNMENT_POLICY_VERSION,
      minimumScore: PRIMARY_ALIGNMENT_MIN_SCORE,
      biases,
      alignedTimeframes: [],
      opposingTimeframes: [],
      neutralTimeframes: [],
      missingTimeframes,
      failures: missingTimeframes,
      contextConflicts: [],
      reason: `Primary timeframe alignment unavailable: missing ${missingTimeframes.join(', ')} classification.`,
    };
  }

  const opposite = expected === 'bullish' ? 'bearish' : 'bullish';
  const alignedTimeframes = PRIMARY_ALIGNMENT_TIMEFRAMES.filter((tf) => biases[tf] === expected);
  const opposingTimeframes = PRIMARY_ALIGNMENT_TIMEFRAMES.filter((tf) => biases[tf] === opposite);
  const neutralTimeframes = PRIMARY_ALIGNMENT_TIMEFRAMES.filter((tf) => biases[tf] === 'neutral');
  const contextConflicts = CONTEXT_ALIGNMENT_TIMEFRAMES.filter((tf) => {
    const bias = biases[tf];
    return bias && bias !== 'neutral' && bias !== expected;
  });

  // Exact policy values: 0, 33, 67, 100. Do not derive a directionless 50%.
  const scores = [0, 33, 67, 100];
  const score = scores[alignedTimeframes.length] ?? 0;
  const dailyH4Aligned = biases.daily === expected && biases.h4 === expected;
  const passed = dailyH4Aligned && score >= PRIMARY_ALIGNMENT_MIN_SCORE;
  const failures = [...opposingTimeframes, ...neutralTimeframes];

  let reason;
  if (!passed) {
    reason = dailyH4Aligned
      ? `Primary timeframe alignment failed: Daily/H4/M15 score ${score}/100 < ${PRIMARY_ALIGNMENT_MIN_SCORE}/100 for ${expected}.`
      : `Primary timeframe alignment failed: Daily and H4 must both align with ${expected}; Daily=${biases.daily}, H4=${biases.h4}.`;
  } else if (opposingTimeframes.length || neutralTimeframes.length) {
    const diagnostics = [
      opposingTimeframes.length ? `opposing=${opposingTimeframes.join(',')}` : null,
      neutralTimeframes.length ? `neutral=${neutralTimeframes.join(',')}` : null,
    ].filter(Boolean).join(' ');
    reason =
      `Primary timeframe alignment passed at ${score}/100 (${alignedTimeframes.length}/3). ` +
      `${diagnostics} is diagnostic only.`;
  } else if (contextConflicts.length) {
    reason =
      `Primary timeframe alignment passed at 100/100. Context conflict only: ` +
      `${contextConflicts.join(', ')}.`;
  } else {
    reason = 'Primary timeframe alignment passed at 100/100: Daily, H4 and M15 aligned.';
  }

  return {
    passed,
    score,
    expected,
    explicitDirection: Boolean(explicitExpected),
    policyVersion: PRIMARY_ALIGNMENT_POLICY_VERSION,
    minimumScore: PRIMARY_ALIGNMENT_MIN_SCORE,
    dailyH4Aligned,
    primaryTimeframes: PRIMARY_ALIGNMENT_TIMEFRAMES,
    contextTimeframes: CONTEXT_ALIGNMENT_TIMEFRAMES,
    biases,
    alignedTimeframes,
    opposingTimeframes,
    neutralTimeframes,
    missingTimeframes,
    failures,
    contextConflicts,
    reason,
  };
}

export function shouldHardRejectForTimeframes(input = {}, direction) {
  return !evaluatePrimaryTimeframeAlignment(input, direction).passed;
}
