import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPrimaryDirectionDisplayPolicy,
  applyPrimaryDirectionToSignal,
  PRIMARY_DIRECTION_DISPLAY_POLICY_VERSION,
} from './v3PrimaryDirectionDisplay.js';
import { calculateDashboardPrimaryAlignment, normalizeScanForV3Display } from './v3ScanDisplayPolicy.js';

test('three bearish primary timeframes override a stale LONG label and score 100', () => {
  const corrected = applyPrimaryDirectionToSignal({
    pair: 'EUR_GBP',
    direction: 'long',
    v3: { direction: 'long' },
    macro: { dailyTrend: 'bearish', h4Trend: 'bearish' },
    structure: { h1Trend: 'bullish', m30Trend: 'neutral' },
    momentum: { m15Trend: 'bearish', m5Trend: 'bearish', executionSignal: null },
  });

  assert.equal(corrected.direction, 'short');
  assert.equal(corrected.primaryDirectionDisplay.score, 100);
  assert.equal(corrected.primaryDirectionDisplay.corrected, true);
  assert.deepEqual(corrected.primaryDirectionDisplay.conflictingSources, ['signal', 'v3']);

  const alignment = calculateDashboardPrimaryAlignment(corrected);
  assert.equal(alignment.expected, 'bearish');
  assert.equal(alignment.direction, 'short');
  assert.equal(alignment.score, 100);
  assert.equal(alignment.passed, true);
  assert.deepEqual(alignment.alignedTimeframes, ['daily', 'h4', 'm15']);
  assert.deepEqual(alignment.opposingTimeframes, []);
  assert.deepEqual(alignment.contextConflicts, ['h1']);
});

test('two bullish primary timeframes produce LONG and 67 regardless of stale SHORT label', () => {
  const corrected = applyPrimaryDirectionToSignal({
    direction: 'short',
    macro: { dailyTrend: 'bullish', h4Trend: 'bearish' },
    momentum: { m15Trend: 'bullish', executionSignal: 'short' },
  });

  assert.equal(corrected.direction, 'long');
  assert.equal(corrected.primaryDirectionDisplay.score, 67);
  const alignment = calculateDashboardPrimaryAlignment(corrected);
  assert.equal(alignment.score, 67);
  assert.equal(alignment.passed, true);
  assert.deepEqual(alignment.opposingTimeframes, ['h4']);
});

test('no two-of-three primary majority does not invent a replacement direction', () => {
  const original = {
    direction: 'long',
    macro: { dailyTrend: 'bullish', h4Trend: 'bearish' },
    momentum: { m15Trend: 'neutral' },
  };
  const corrected = applyPrimaryDirectionToSignal(original);
  assert.equal(corrected, original);
});

test('scan policy corrects every scanner display array before normalization', () => {
  const raw = {
    rejected: [{
      pair: 'EUR_GBP',
      direction: 'long',
      macro: { dailyTrend: 'bearish', h4Trend: 'bearish' },
      momentum: { m15Trend: 'bearish' },
      rejectionReasons: [
        'Primary timeframe alignment failed: Daily + H4 + M15 score 50/100 < 67/100.',
      ],
    }],
    watchCandidates: [{
      pair: 'USD_JPY',
      direction: 'short',
      macro: { dailyTrend: 'bullish', h4Trend: 'bullish' },
      momentum: { m15Trend: 'bullish' },
    }],
  };

  const corrected = applyPrimaryDirectionDisplayPolicy(raw);
  assert.equal(corrected.rejected[0].direction, 'short');
  assert.equal(corrected.watchCandidates[0].direction, 'long');
  assert.equal(corrected.meta.primaryDirectionDisplayPolicy, PRIMARY_DIRECTION_DISPLAY_POLICY_VERSION);

  const normalized = normalizeScanForV3Display(corrected);
  const eurGbp = normalized.nearQualified.find((item) => item.pair === 'EUR_GBP')
    || normalized.v3PrimaryPassedContext.find((item) => item.pair === 'EUR_GBP');
  assert.ok(eurGbp);
  assert.equal(eurGbp.direction, 'short');
  assert.equal(eurGbp.alignment.timeframeAlignmentScore, 100);
  assert.equal(
    eurGbp.rejectionReasons.some((reason) => String(reason).includes('Primary timeframe alignment failed')),
    false,
  );
});
