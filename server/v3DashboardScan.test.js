import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyV3DashboardWatch } from './v3DashboardScan.js';

function candidate({
  pair = 'EUR_USD',
  direction = 'long',
  timing = 'wait_for_retest',
  stage1Allowed = true,
  stage1Reasons = [],
  stage2Allowed = false,
  stage2State = 'watch',
  stage2Reasons = ['no fresh primary trigger'],
  newsBlocked = false,
  timeframes = { daily: 'bullish', h4: 'bullish', m15: 'bearish' },
  alignmentScore = 67,
} = {}) {
  const expected = direction === 'short' ? 'bearish' : direction === 'long' ? 'bullish' : null;
  const alignment = {
    passed: stage1Allowed || alignmentScore >= 67,
    score: alignmentScore,
    expected,
    minimumScore: 67,
    dailyH4Aligned: alignmentScore >= 67,
    m15Aligned: alignmentScore === 100,
    biases: timeframes,
    opposingTimeframes: expected
      ? Object.entries(timeframes).filter(([, value]) => value !== expected).map(([key]) => key)
      : [],
    failures: [],
    reason: expected ? `Primary timeframe alignment ${alignmentScore >= 67 ? 'passed' : 'failed'}.` : 'No executable direction.',
  };

  return {
    pair,
    direction,
    score: 60,
    entryTiming: { status: timing, reason: stage2Reasons[0] || null },
    newsRisk: { blocked: newsBlocked },
    v3: {
      direction,
      score: 60,
      timeframes,
      primaryTimeframeAlignment: alignment,
      structure: {
        structureTrend: expected || 'ranging',
        structureStrength: 72,
        chochDetected: false,
        timeframeUsed: 'M15',
        h1Used: false,
      },
      volatility: { volatilityState: 'normal' },
    },
    qualityConfirmation: {
      stage1: {
        stage: 1,
        allowed: stage1Allowed,
        state: stage1Allowed ? 'watch' : 'blocked',
        reasons: stage1Reasons,
        metrics: { newsBlocked, alignment, score: 60 },
      },
      stage2: {
        stage: 2,
        allowed: stage2Allowed,
        state: stage2State,
        reasons: stage2Reasons,
        primaryTriggers: [],
        supports: [],
      },
    },
    architecture: 'independent_v3_raw_market_data',
    legacyScannerUsed: false,
  };
}

test('native Stage 1 pass plus Stage 2 watch becomes Hot Watch', () => {
  const item = candidate();
  const result = classifyV3DashboardWatch({
    watchCandidates: [item],
    rejected: [item],
  });

  assert.equal(result.hotWatch.length, 1);
  assert.equal(result.nearQualified.length, 0);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.hotWatch[0].dashboardWatchTier.tier, 'hot');
  assert.equal(result.hotWatch[0].qualityConfirmation.stage1.allowed, true);
  assert.equal(result.hotWatch[0].qualityConfirmation.stage2.state, 'watch');
});

test('native Stage 1 score development becomes Near Qualified with its real blocker', () => {
  const item = candidate({
    pair: 'USD_CHF',
    timing: 'too_early',
    stage1Allowed: false,
    stage1Reasons: ['V3 score 60 < 62'],
    stage2State: 'blocked',
    stage2Reasons: ['stage 1 setup did not pass'],
  });
  const result = classifyV3DashboardWatch({ rejected: [item], watchCandidates: [] });

  assert.equal(result.hotWatch.length, 0);
  assert.equal(result.nearQualified.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.nearQualified[0].dashboardWatchTier.tier, 'near');
  assert.equal(result.nearQualified[0].dashboardWatchTier.reason, 'V3 score 60 < 62');
});

test('dashboard uses Daily H4 M15 for alignment and marks H1 as fib only', () => {
  const item = candidate({
    pair: 'USD_JPY',
    stage1Allowed: false,
    stage1Reasons: ['V3 score 60 < 62'],
    timeframes: { daily: 'bullish', h4: 'bullish', m15: 'bearish' },
    alignmentScore: 67,
  });
  const result = classifyV3DashboardWatch({ rejected: [item], watchCandidates: [] });
  const displayed = result.nearQualified[0];

  assert.equal(displayed.alignment.timeframes.daily, 'bullish');
  assert.equal(displayed.alignment.timeframes.h4, 'bullish');
  assert.equal(displayed.alignment.timeframes.m15, 'bearish');
  assert.equal(displayed.alignment.timeframes.h1, 'fib_only');
  assert.equal(displayed.alignment.timeframes.m30, 'n/a');
  assert.equal(displayed.alignment.timeframeAlignmentScore, 67);
  assert.equal(displayed.macro.macroBias, 'bullish');
  assert.equal(displayed.macro.macroConfidence, 67);
  assert.equal(displayed.structure.h1Trend, 'fib_only');
  assert.equal(displayed.v3.structure.timeframeUsed, 'M15');
  assert.equal(displayed.v3.structure.h1Used, false);
  assert.equal(displayed.legacyScannerUsed, false);
  assert.equal(displayed.legacyConfirmationsUsed, false);
});

test('100 alignment requires Daily H4 and M15 to agree', () => {
  const item = candidate({
    pair: 'EUR_GBP',
    timeframes: { daily: 'bearish', h4: 'bearish', m15: 'bearish' },
    direction: 'short',
    alignmentScore: 100,
  });
  const result = classifyV3DashboardWatch({ watchCandidates: [item], rejected: [item] });
  const displayed = result.hotWatch[0];

  assert.equal(displayed.alignment.timeframeAlignmentScore, 100);
  assert.equal(displayed.alignment.alignmentStatus, 'strong');
  assert.deepEqual(
    [displayed.alignment.timeframes.daily, displayed.alignment.timeframes.h4, displayed.alignment.timeframes.m15],
    ['bearish', 'bearish', 'bearish'],
  );
  assert.equal(displayed.alignment.timeframes.h1, 'fib_only');
});

test('hard native blockers are rejected instead of being labeled as waiting', () => {
  const newsBlocked = candidate({
    pair: 'GBP_USD',
    stage1Allowed: false,
    stage1Reasons: ['news block active'],
    newsBlocked: true,
  });
  const alignmentBlocked = candidate({
    pair: 'USD_CAD',
    direction: null,
    timing: 'invalidated',
    stage1Allowed: false,
    stage1Reasons: ['Primary timeframe alignment failed: Daily and H4 must both align'],
    timeframes: { daily: 'bullish', h4: 'bearish', m15: 'bullish' },
    alignmentScore: 33,
  });
  const geometryBlocked = candidate({
    pair: 'AUD_USD',
    stage1Allowed: false,
    stage1Reasons: ['geometric R:R 1.2 < 1.5'],
  });

  const result = classifyV3DashboardWatch({
    watchCandidates: [],
    rejected: [newsBlocked, alignmentBlocked, geometryBlocked],
  });

  assert.equal(result.hotWatch.length, 0);
  assert.equal(result.nearQualified.length, 0);
  assert.deepEqual(result.rejected.map((item) => item.pair), ['GBP_USD', 'USD_CAD', 'AUD_USD']);
});

test('a completed or terminal Stage 2 state is never presented as in progress', () => {
  const ready = candidate({
    pair: 'EUR_GBP',
    timing: 'valid_entry',
    stage2Allowed: true,
    stage2State: 'ready',
    stage2Reasons: [],
  });
  const late = candidate({
    pair: 'EUR_CHF',
    timing: 'late_entry',
    stage2Allowed: false,
    stage2State: 'blocked',
    stage2Reasons: ['entry timing late_entry is not executable'],
  });

  const result = classifyV3DashboardWatch({
    watchCandidates: [ready, late],
    rejected: [late],
  });

  assert.equal(result.hotWatch.length, 0);
  assert.equal(result.nearQualified.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].pair, 'EUR_CHF');
});
