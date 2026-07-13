import { detectTrend } from './oandaIndicators.js';

export const V3_PRIMARY_ALIGNMENT_MIN_SCORE = 67;
export const V3_PRIMARY_TIMEFRAMES = ['daily', 'h4', 'm15'];

function normalizeDirection(value) {
  const v = String(value || '').trim().toLowerCase();
  if (['long', 'buy', 'bullish'].includes(v)) return 'long';
  if (['short', 'sell', 'bearish'].includes(v)) return 'short';
  return null;
}

function normalizeBias(value) {
  const v = String(value || '').trim().toLowerCase();
  if (['bull', 'bullish', 'buy', 'long', 'up'].includes(v)) return 'bullish';
  if (['bear', 'bearish', 'sell', 'short', 'down'].includes(v)) return 'bearish';
  if (['neutral', 'mixed', 'flat', 'range', 'ranging', 'none'].includes(v)) return 'neutral';
  return null;
}

function expectedBias(direction) {
  const normalized = normalizeDirection(direction);
  if (normalized === 'long') return 'bullish';
  if (normalized === 'short') return 'bearish';
  return null;
}

function finiteCloses(candles = []) {
  return candles
    .map((candle) => Number(candle?.close))
    .filter(Number.isFinite);
}

export function trendFromCandles(candles = [], minimumBars = 1) {
  const closes = finiteCloses(candles);
  if (closes.length < minimumBars) return null;
  return normalizeBias(detectTrend(closes));
}

/**
 * V3-owned primary-timeframe gate.
 *
 * 3/3 aligned = 100 (pass)
 * 2/3 aligned =  67 (pass)
 * 1/3 aligned =  33 (reject)
 * 0/3 aligned =   0 (reject)
 *
 * An opposing individual timeframe is diagnostic only. The aggregate score is
 * the sole directional-alignment rejection criterion.
 */
export function evaluateV3PrimaryAlignment({ direction, dailyTrend, h4Trend, m15Trend } = {}) {
  const normalizedDirection = normalizeDirection(direction);
  const expected = expectedBias(normalizedDirection);
  const trends = {
    daily: normalizeBias(dailyTrend),
    h4: normalizeBias(h4Trend),
    m15: normalizeBias(m15Trend),
  };

  const missingTimeframes = V3_PRIMARY_TIMEFRAMES.filter((timeframe) => trends[timeframe] === null);
  if (!expected || missingTimeframes.length > 0) {
    return {
      passed: false,
      status: 'insufficient_data',
      direction: normalizedDirection,
      expectedBias: expected,
      score: 0,
      minimumScore: V3_PRIMARY_ALIGNMENT_MIN_SCORE,
      trends,
      alignedTimeframes: [],
      opposingTimeframes: [],
      neutralTimeframes: [],
      missingTimeframes,
      reason: !expected
        ? 'V3 primary alignment rejected: no V3 direction was available.'
        : `V3 primary alignment rejected: missing ${missingTimeframes.join(', ')} trend data.`,
    };
  }

  const alignedTimeframes = V3_PRIMARY_TIMEFRAMES.filter((timeframe) => trends[timeframe] === expected);
  const opposingBias = expected === 'bullish' ? 'bearish' : 'bullish';
  const opposingTimeframes = V3_PRIMARY_TIMEFRAMES.filter((timeframe) => trends[timeframe] === opposingBias);
  const neutralTimeframes = V3_PRIMARY_TIMEFRAMES.filter((timeframe) => trends[timeframe] === 'neutral');
  const scoreByAlignedCount = [0, 33, 67, 100];
  const score = scoreByAlignedCount[alignedTimeframes.length];
  const passed = score >= V3_PRIMARY_ALIGNMENT_MIN_SCORE;

  return {
    passed,
    status: passed ? 'passed' : 'rejected',
    direction: normalizedDirection,
    expectedBias: expected,
    score,
    minimumScore: V3_PRIMARY_ALIGNMENT_MIN_SCORE,
    trends,
    alignedTimeframes,
    opposingTimeframes,
    neutralTimeframes,
    missingTimeframes: [],
    diagnostic: opposingTimeframes.length > 0
      ? `${opposingTimeframes.join(', ')} opposes the V3 ${normalizedDirection} direction; aggregate score remains authoritative.`
      : null,
    reason: passed
      ? `V3 primary alignment passed: Daily/H4/M15 score ${score}/100.`
      : `V3 primary alignment rejected: Daily/H4/M15 score ${score}/100 < ${V3_PRIMARY_ALIGNMENT_MIN_SCORE}/100.`,
  };
}

export function evaluateV3PrimaryAlignmentFromCandles({
  direction,
  dailyCandles = [],
  h4Candles = [],
  m15Candles = [],
} = {}) {
  return evaluateV3PrimaryAlignment({
    direction,
    dailyTrend: trendFromCandles(dailyCandles, 30),
    h4Trend: trendFromCandles(h4Candles, 50),
    m15Trend: trendFromCandles(m15Candles, 60),
  });
}
