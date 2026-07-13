import test from 'node:test';
import assert from 'node:assert/strict';

import { computeAlignment } from './oandaMtfAnalysis.js';
import {
  PRIMARY_ALIGNMENT_MIN_SCORE,
  evaluatePrimaryTimeframeAlignment,
} from './primaryTimeframeAlignment.js';
import {
  V3_LEGACY_MIN_PRIMARY_ALIGNMENT_SCORE,
  selectV3ReviewCandidates,
} from './v3LegacyBoundary.js';

function baseLayers({ daily = 'bullish', h4 = 'bullish', m15 = 'bullish' } = {}) {
  return {
    macro: {
      macroBias: 'bullish',
      dailyTrend: daily,
      h4Trend: h4,
      macroConfidence: 90,
      volatilityRegime: 'normal',
    },
    structure: {
      h1Trend: 'bullish',
      m30Trend: 'bullish',
      structuralConfidence: 90,
      reversalRisk: 'low',
    },
    momentum: {
      m15Trend: m15,
      m5Trend: 'bullish',
      executionSignal: 'long',
      executionConfidence: 90,
      atrPips: 10,
    },
  };
}

test('V3 never reviews scan.rejected', () => {
  const qualified = {
    pair: 'EUR_USD',
    alignment: { timeframeAlignmentScore: 100 },
  };
  const rejected = {
    pair: 'GBP_USD',
    alignment: { timeframeAlignmentScore: 100 },
  };
  const selected = selectV3ReviewCandidates({ qualified: [qualified], rejected: [rejected] });
  assert.deepEqual(selected, [qualified]);
});

test('V3 rejects 66 and accepts 67 at the legacy boundary', () => {
  const score66 = { pair: 'EUR_USD', alignment: { timeframeAlignmentScore: 66 } };
  const score67 = { pair: 'GBP_USD', alignment: { timeframeAlignmentScore: 67 } };
  const selected = selectV3ReviewCandidates({ qualified: [score66, score67] });

  assert.equal(V3_LEGACY_MIN_PRIMARY_ALIGNMENT_SCORE, 67);
  assert.deepEqual(selected, [score67]);
});

test('one opposing primary timeframe is diagnostic when the score is 67', () => {
  const result = computeAlignment(baseLayers({ m15: 'bearish' }));

  assert.equal(result.timeframeAlignmentScore, 67);
  assert.deepEqual(result.primaryConflictingTimeframes, ['m15']);
  assert.equal(result.primaryConflictPolicy, 'diagnostic_only');
  assert.equal(result.rejectionReasons.some((reason) => reason.includes('Primary timeframe conflict')), false);
  assert.equal(result.tradeQualified, true);
});

test('primary alignment below 67 remains a hard rejection', () => {
  const result = computeAlignment(baseLayers({ h4: 'bearish', m15: 'bearish' }));

  assert.equal(result.timeframeAlignmentScore, 33);
  assert.equal(result.tradeQualified, false);
  assert.equal(result.rejectionReasons.some((reason) => reason.includes('score 33/100 < 67/100')), true);
});

test('primary policy uses a 2-of-3 score rather than unanimity', () => {
  const result = evaluatePrimaryTimeframeAlignment({
    timeframes: {
      daily: 'bullish',
      h4: 'bullish',
      m15: 'bearish',
      h1: 'bearish',
    },
  }, 'long');

  assert.equal(PRIMARY_ALIGNMENT_MIN_SCORE, 67);
  assert.equal(result.score, 67);
  assert.equal(result.passed, true);
  assert.deepEqual(result.primaryConflicts, ['m15']);
});
