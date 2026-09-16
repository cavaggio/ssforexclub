import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeIctExhaustionRisk,
  evaluateIctAGradeSetup,
} from './ictAGradePrecision.js';

function baseContinuation(overrides = {}) {
  return {
    pair: 'GBP_JPY',
    signal: 'sell',
    confidence: 88,
    rr: 1.6,
    entryTimeframe: '5M',
    entryCandle: { triggerReady: true },
    freshImpulse: true,
    triggerAgeBars: 0,
    timeframeBias: { d1: 'bearish', h4: 'bearish', d1H4Aligned: true },
    h1Momentum: {
      aligned: true,
      activeAligned: true,
      currentAligned: true,
      currentOpposing: false,
      exhausted: false,
      phase: 'live_impulse',
    },
    h1Transition: { ready: false },
    continuationBreakout: { ready: true, retestConfirmed: true },
    entryAuthorization: {
      ready: true,
      mode: 'm5_continuation_breakout',
      cycleId: 'gj-short-cycle-1',
    },
    correctiveGate: {
      passed: true,
      decision: 'authorize',
      family: 'continuation',
      failureCodes: [],
    },
    marketMakerModel: {
      studyReady: true,
      stage: 'DISTRIBUTION_ACTIVE',
      cycle: {},
      observation: {},
    },
    combinedLearningContext: { combinedAdjustment: 0 },
    ...overrides,
  };
}

function baseReversal(overrides = {}) {
  return {
    pair: 'EUR_USD',
    signal: 'buy',
    confidence: 90,
    rr: 1.7,
    entryTimeframe: '5M',
    entryCandle: { triggerReady: true },
    freshImpulse: true,
    triggerAgeBars: 0,
    timeframeBias: { d1: 'bearish', h4: 'bullish', d1H4Aligned: false },
    h1Momentum: { aligned: false, exhausted: true, currentOpposing: false },
    entryAuthorization: {
      ready: true,
      mode: 'initial_reversal_ifvg',
      cycleId: 'eu-reversal-cycle-1',
    },
    correctiveGate: {
      passed: true,
      decision: 'authorize',
      family: 'reversal',
      failureCodes: [],
    },
    marketMakerModel: {
      studyReady: true,
      stage: 'DISTRIBUTION_ACTIVE',
      keyLevelTap: { aligned: true },
      cycle: {
        keyLevel: { tappedAt: '2026-09-15T07:30:00Z' },
        manipulation: { time: '2026-09-15T07:35:00Z' },
        displacement: { time: '2026-09-15T07:40:00Z' },
      },
      observation: {
        sweepAligned: true,
        displacementFresh: true,
        inverseFvg: { confirmed: true },
      },
    },
    concepts: { cisd: { confirmed: true } },
    ...overrides,
  };
}

test('A-grade continuation requires aligned HTF/H1 and a fresh distribution trigger', () => {
  const result = evaluateIctAGradeSetup(baseContinuation());
  assert.equal(result.passed, true);
  assert.equal(result.grade, 'A');
  assert.ok(result.score >= 80);
  assert.equal(result.exhaustionRiskScore, 0);
});

test('one-bar freshness can remain A-grade, but two-bar trigger age is rejected', () => {
  const oneBar = evaluateIctAGradeSetup(baseContinuation({ triggerAgeBars: 1 }));
  assert.equal(oneBar.passed, true);

  const twoBars = evaluateIctAGradeSetup(baseContinuation({ triggerAgeBars: 2 }));
  assert.equal(twoBars.passed, false);
  assert.ok(twoBars.blockers.some((reason) => reason.includes('trigger age')));
});

test('final-price A-grade gate rejects an entry that has consumed too much of the move', () => {
  const targetConfidence = {
    confidence: 86,
    actualRR: 1.6,
    timingScore: 72,
    geometryScore: 96,
    entryDriftAtr: 0.48,
    rewardConsumedFraction: 0.42,
    priceInsideEntryZone: false,
  };
  const result = evaluateIctAGradeSetup(baseContinuation(), {
    targetConfidence,
    stage: 'final_price',
  });
  assert.equal(result.passed, false);
  assert.ok(result.exhaustionRiskScore > 39);
  assert.ok(result.blockers.some((reason) => reason.includes('reward consumed')));
  assert.ok(result.blockers.some((reason) => reason.includes('timing score')));
});

test('full reversal sequence can be A-grade without requiring D1/H4 continuation alignment', () => {
  const result = evaluateIctAGradeSetup(baseReversal());
  assert.equal(result.passed, true);
  assert.equal(result.family, 'reversal');
  assert.ok(result.score >= 80);
});

test('reversal is rejected if the liquidity raid sequence is incomplete', () => {
  const result = evaluateIctAGradeSetup(baseReversal({
    marketMakerModel: {
      studyReady: true,
      stage: 'DISTRIBUTION_ACTIVE',
      keyLevelTap: { aligned: true },
      cycle: { keyLevel: { tappedAt: '2026-09-15T07:30:00Z' } },
      observation: { sweepAligned: false, displacementFresh: false },
    },
    concepts: {},
  }));
  assert.equal(result.passed, false);
  assert.ok(result.blockers.some((reason) => reason.includes('liquidity sweep')));
  assert.ok(result.blockers.some((reason) => reason.includes('displacement')));
});

test('exhaustion score penalizes opposing continuation momentum', () => {
  const analysis = baseContinuation({
    h1Momentum: {
      aligned: false,
      activeAligned: false,
      currentAligned: false,
      currentOpposing: true,
      exhausted: true,
    },
  });
  const risk = computeIctExhaustionRisk(analysis, {
    timingScore: 70,
    entryDriftAtr: 0.40,
    rewardConsumedFraction: 0.30,
    priceInsideEntryZone: false,
  });
  assert.ok(risk.score >= 80);
  assert.ok(risk.reasons.length >= 3);
});
