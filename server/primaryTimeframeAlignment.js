/**
 * Primary timeframe alignment policy.
 *
 * HARD GATE:
 *   Daily + H4 are the minimum directional requirement. Both must align with
 *   the intended direction and together score 67/100.
 *
 * FULL ALIGNMENT:
 *   Daily + H4 + M15 aligned with the intended direction score 100/100.
 *   M15 can improve 67 to 100, but it cannot replace either Daily or H4.
 *
 * EXCLUDED FROM ALIGNMENT:
 *   H1 does not contribute to direction, alignment score, alignment conflicts,
 *   or the Daily/H4 hard gate. H1 remains available to other V3 analysis layers,
 *   including market structure and Fibonacci analysis.
 *
 * SOFT CONTEXT ONLY:
 *   M30 + M5 may warn/conflict, but they must not reject an otherwise valid
 *   Daily/H4 setup.
 */

export const HARD_ALIGNMENT_TIMEFRAMES = ['daily', 'h4'];
export const PRIMARY_ALIGNMENT_TIMEFRAMES = ['daily', 'h4', 'm15'];
export const CONTEXT_ALIGNMENT_TIMEFRAMES = ['m30', 'm5'];
export const PRIMARY_ALIGNMENT_MIN_SCORE = 67;
export const PRIMARY_ALIGNMENT_POLICY_VERSION = 'v3-primary-daily-h4-67-m15-100-2026-07-17';

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
  const missingHardTimeframes = HARD_ALIGNMENT_TIMEFRAMES.filter((tf) => !biases[tf]);

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
      missingHardTimeframes,
      failures: [...HARD_ALIGNMENT_TIMEFRAMES],
      contextConflicts: [],
      reason: 'No executable Daily/H4 direction is available.',
    };
  }

  // Daily and H4 fail closed. M15 is an enhancement from 67 to 100 and may be
  // missing, neutral, or opposing without replacing the Daily/H4 hard pair.
  if (missingHardTimeframes.length > 0) {
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
      missingHardTimeframes,
      failures: missingHardTimeframes,
      contextConflicts: [],
      reason: `Primary timeframe alignment unavailable: missing ${missingHardTimeframes.join(', ')} classification.`,
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

  // Exact policy values: Daily+H4 = 67. Daily+H4+M15 = 100.
  // Other combinations remain diagnostic only and can never pass the hard gate.
  const dailyH4Aligned = biases.daily === expected && biases.h4 === expected;
  const m15Aligned = biases.m15 === expected;
  const score = dailyH4Aligned ? (m15Aligned ? 100 : 67) : [0, 33, 67, 100][alignedTimeframes.length] ?? 0;
  const passed = dailyH4Aligned && score >= PRIMARY_ALIGNMENT_MIN_SCORE;
  const failures = [...opposingTimeframes, ...neutralTimeframes, ...missingTimeframes]
    .filter((tf, index, all) => all.indexOf(tf) === index);

  let reason;
  if (!passed) {
    reason = `Primary timeframe alignment failed: Daily and H4 must both align with ${expected}; Daily=${biases.daily}, H4=${biases.h4}.`;
  } else if (!m15Aligned) {
    const m15State = biases.m15 || 'missing';
    reason =
      `Primary timeframe alignment passed at 67/100: Daily and H4 align with ${expected}; ` +
      `M15=${m15State} is diagnostic and is required only for 100/100.`;
  } else if (contextConflicts.length) {
    reason =
      `Primary timeframe alignment passed at 100/100: Daily, H4 and M15 aligned. ` +
      `Context conflict only: ${contextConflicts.join(', ')}.`;
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
    m15Aligned,
    hardTimeframes: HARD_ALIGNMENT_TIMEFRAMES,
    primaryTimeframes: PRIMARY_ALIGNMENT_TIMEFRAMES,
    contextTimeframes: CONTEXT_ALIGNMENT_TIMEFRAMES,
    biases,
    alignedTimeframes,
    opposingTimeframes,
    neutralTimeframes,
    missingTimeframes,
    missingHardTimeframes,
    failures,
    contextConflicts,
    reason,
  };
}

export function shouldHardRejectForTimeframes(input = {}, direction) {
  return !evaluatePrimaryTimeframeAlignment(input, direction).passed;
}
