import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateDashboardPrimaryAlignment,
  classifyDashboardWatchTier,
  normalizeScanForV3Display,
  normalizeSignalForV3Display,
  V3_PROVISIONING_POLICY_VERSION,
} from './v3ScanDisplayPolicy.js';

test('two of three primary timeframes produces 67 and passes, never 50', () => {
  const result = calculateDashboardPrimaryAlignment({
    v3: { direction: 'long' },
    macro: { dailyTrend: 'bullish', h4Trend: 'bearish' },
    momentum: { m15Trend: 'bullish' },
  });

  assert.equal(result.score, 67);
  assert.equal(result.passed, true);
  assert.equal(result.policyVersion, V3_PROVISIONING_POLICY_VERSION);
  assert.deepEqual(result.opposingTimeframes, ['h4']);
});

test('majority direction is derived when legacy macro confidence and execution signal are zero', () => {
  const result = calculateDashboardPrimaryAlignment({
    macro: {
      dailyTrend: 'bullish',
      h4Trend: 'bearish',
      macroConfidence: 0,
    },
    momentum: {
      m15Trend: 'bullish',
      executionSignal: null,
      executionConfidence: 0,
    },
  });

  assert.equal(result.direction, 'long');
  assert.equal(result.score, 67);
  assert.equal(result.passed, true);
});

test('legacy macro structural and execution confidence reasons become diagnostics only', () => {
  const signal = normalizeSignalForV3Display({
    pair: 'EUR_USD',
    v3: { direction: 'long', score: 64 },
    macro: {
      dailyTrend: 'bullish',
      h4Trend: 'bearish',
      macroConfidence: 0,
    },
    structure: {
      h1Trend: 'neutral',
      m30Trend: 'neutral',
      structuralConfidence: 0,
    },
    momentum: {
      m15Trend: 'bullish',
      m5Trend: 'neutral',
      executionSignal: null,
      executionConfidence: 0,
    },
    alignment: {
      timeframeAlignmentScore: 50,
      rejectionReasons: [
        'Macro confidence 0 < min 30',
        'Structural confidence 0 < min 30',
        'Execution confidence 0 < min 35',
        'Primary timeframe alignment failed: Daily + H4 + M15 score 50/100 < 67/100.',
      ],
    },
    rejectionReasons: [
      'Macro confidence 0 < min 30',
      'Structural confidence 0 < min 30',
      'Execution confidence 0 < min 35',
      'Primary timeframe alignment failed: Daily + H4 + M15 score 50/100 < 67/100.',
    ],
  });

  assert.equal(signal.direction, 'long');
  assert.equal(signal.alignment.timeframeAlignmentScore, 67);
  assert.equal(signal.alignment.tradeQualified, true);
  assert.deepEqual(signal.rejectionReasons, []);
  assert.equal(signal.legacyDiagnosticsRemoved.length, 4);
  assert.equal(signal.alignment.legacyConfidenceDiagnostics.gateStatus, 'diagnostic_only_for_v3');
});

test('legacy candle strength profile floor is diagnostic but exhaustion risk remains blocking', () => {
  const signal = normalizeSignalForV3Display({
    direction: 'short',
    macro: { dailyTrend: 'bearish', h4Trend: 'bullish' },
    momentum: { m15Trend: 'bearish' },
    profile: { minCandleStrength: 50 },
    rejectionReasons: [
      'Rejected: candle strength 47 < profile floor 50. strong candle: body 64% of range, close 88% to low, bearish engulfing',
      'Risk monitor: Last candle body is over-extended — possible exhaustion, avoid chasing',
    ],
    alignment: {
      rejectionReasons: [
        'Rejected: candle strength 47 < profile floor 50. strong candle: body 64% of range, close 88% to low, bearish engulfing',
        'Risk monitor: Last candle body is over-extended — possible exhaustion, avoid chasing',
      ],
    },
  });

  assert.equal(signal.primaryTimeframeAlignment.score, 67);
  assert.deepEqual(signal.rejectionReasons, [
    'Risk monitor: Last candle body is over-extended — possible exhaustion, avoid chasing',
  ]);
  assert.equal(signal.legacyDiagnosticsRemoved.length, 1);
  assert.match(signal.legacyDiagnosticsRemoved[0], /candle strength 47 < profile floor 50/i);
  assert.equal(signal.alignment.tradeQualified, false);
  assert.equal(signal.alignment.legacyConfidenceDiagnostics.candleStrengthFloor, 50);
});

test('ranging profile rejection becomes diagnostic after V3 primary alignment passes', () => {
  const signal = normalizeSignalForV3Display({
    direction: 'long',
    macro: { dailyTrend: 'bearish', h4Trend: 'bullish' },
    momentum: { m15Trend: 'bullish' },
    rejectionReasons: [
      'Rejected: Forex profile does not allow RANGING state (allowed: TRENDING, BREAKOUT)',
    ],
    alignment: {
      rejectionReasons: [
        'Rejected: Forex profile does not allow RANGING state (allowed: TRENDING, BREAKOUT)',
      ],
    },
  });

  assert.equal(signal.primaryTimeframeAlignment.score, 67);
  assert.deepEqual(signal.rejectionReasons, []);
  assert.equal(signal.alignment.tradeQualified, true);
  assert.equal(signal.legacyDiagnosticsRemoved.length, 1);
  assert.match(signal.legacyDiagnosticsRemoved[0], /does not allow ranging/i);
});

test('choppy market rejection remains blocking even when primary alignment passes', () => {
  const signal = normalizeSignalForV3Display({
    direction: 'short',
    macro: { dailyTrend: 'bearish', h4Trend: 'bullish' },
    momentum: { m15Trend: 'bearish' },
    rejectionReasons: [
      'Rejected: market is CHOPPY with whipsaw risk and overlapping price action',
    ],
    alignment: {
      rejectionReasons: [
        'Rejected: market is CHOPPY with whipsaw risk and overlapping price action',
      ],
    },
  });

  assert.equal(signal.primaryTimeframeAlignment.score, 67);
  assert.deepEqual(signal.rejectionReasons, [
    'Rejected: market is CHOPPY with whipsaw risk and overlapping price action',
  ]);
  assert.equal(signal.alignment.tradeQualified, false);
  assert.deepEqual(signal.legacyDiagnosticsRemoved, []);
});

test('valid news or risk rejection is retained', () => {
  const signal = normalizeSignalForV3Display({
    direction: 'short',
    macro: { dailyTrend: 'bearish', h4Trend: 'bearish' },
    momentum: { m15Trend: 'bullish' },
    rejectionReasons: [
      'Macro confidence 0 < min 30',
      'News block: high-impact USD event',
    ],
    alignment: {
      rejectionReasons: [
        'Macro confidence 0 < min 30',
        'News block: high-impact USD event',
      ],
    },
  });

  assert.equal(signal.primaryTimeframeAlignment.score, 67);
  assert.deepEqual(signal.rejectionReasons, ['News block: high-impact USD event']);
  assert.equal(signal.alignment.tradeQualified, false);
});

test('one of three primary timeframes remains rejected at 33', () => {
  const result = calculateDashboardPrimaryAlignment({
    direction: 'long',
    macro: { dailyTrend: 'bearish', h4Trend: 'bearish' },
    momentum: { m15Trend: 'bullish' },
  });

  assert.equal(result.score, 33);
  assert.equal(result.passed, false);
});

test('wait-for-retest is displayed as Hot Watch instead of rejected', () => {
  const tier = classifyDashboardWatchTier({
    direction: 'long',
    macro: { dailyTrend: 'bullish', h4Trend: 'bearish' },
    momentum: { m15Trend: 'bullish' },
    entryTiming: { status: 'wait_for_retest', reason: 'Breakout confirmed; wait for retest.' },
    rejectionReasons: ['Entry timing: Breakout confirmed; wait for retest.'],
  });

  assert.equal(tier.tier, 'hot');
  assert.match(tier.reason, /retest/i);
});

test('too-early setup is displayed as Near Qualified', () => {
  const tier = classifyDashboardWatchTier({
    direction: 'short',
    macro: { dailyTrend: 'bearish', h4Trend: 'bullish' },
    momentum: { m15Trend: 'bearish' },
    entryTiming: { status: 'too_early', reason: 'Price has not entered the setup zone.' },
  });

  assert.equal(tier.tier, 'near');
});

test('hard news and spread blocks remain rejected rather than watched', () => {
  const news = classifyDashboardWatchTier({
    direction: 'long',
    macro: { dailyTrend: 'bullish', h4Trend: 'bullish' },
    momentum: { m15Trend: 'bearish' },
    entryTiming: { status: 'wait_for_retest' },
    newsRisk: { blocked: true },
  });
  const spread = classifyDashboardWatchTier({
    direction: 'long',
    macro: { dailyTrend: 'bullish', h4Trend: 'bullish' },
    momentum: { m15Trend: 'bearish' },
    entryTiming: { status: 'wait_for_retest' },
    rejectionReasons: ['V3 native scan rejected: spread 4.2p > 3.5p.'],
  });

  assert.equal(news.tier, 'none');
  assert.equal(spread.tier, 'none');
});

test('scan normalization separates Hot Watch and Near Qualified from red rejections', () => {
  const scan = normalizeScanForV3Display({
    qualified: [],
    rejected: [
      {
        pair: 'EUR_USD',
        direction: 'long',
        macro: { dailyTrend: 'bullish', h4Trend: 'bearish' },
        momentum: { m15Trend: 'bullish' },
        entryTiming: { status: 'wait_for_retest', reason: 'Waiting for retest.' },
      },
      {
        pair: 'GBP_USD',
        direction: 'short',
        macro: { dailyTrend: 'bearish', h4Trend: 'bullish' },
        momentum: { m15Trend: 'bearish' },
        entryTiming: { status: 'too_early', reason: 'Waiting for setup zone.' },
      },
      {
        pair: 'USD_JPY',
        direction: 'long',
        macro: { dailyTrend: 'bullish', h4Trend: 'bullish' },
        momentum: { m15Trend: 'bearish' },
        rejectionReasons: ['News block: high-impact USD event'],
      },
    ],
    meta: {},
  });

  assert.deepEqual(scan.hotWatch.map((signal) => signal.pair), ['EUR_USD']);
  assert.deepEqual(scan.nearQualified.map((signal) => signal.pair), ['GBP_USD']);
  assert.deepEqual(scan.rejected.map((signal) => signal.pair), ['USD_JPY']);
  assert.equal(scan.meta.hotWatchCount, 1);
  assert.equal(scan.meta.nearQualifiedCount, 1);
});
