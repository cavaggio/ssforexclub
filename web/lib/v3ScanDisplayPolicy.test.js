import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateDashboardPrimaryAlignment,
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
