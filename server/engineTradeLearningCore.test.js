import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyBoundedConfidence,
  computeEngineTradeAdjustment,
} from './engineTradeLearningCore.js';
import {
  assessCandidateExecutionQuality,
  separateSignalAndExecutionLearning,
} from './signalExecutionQuality.js';

function matureProfile(overrides = {}) {
  return {
    engine: 'ict',
    pair: 'EUR_USD',
    pairSummary: { outcomes: 100, expectancy_r: 0.42, win_rate: 64 },
    contextStats: [{
      engine: 'ict', pair: 'EUR_USD', direction: 'long', session: 'london',
      market_regime: 'trending', volatility: 'expanding', daily_direction: 'bullish',
      h4_direction: 'bullish', outcomes: 55, expectancy_r: 0.38,
    }],
    confirmationStats: [{
      confirmation: 'liquidity_sweep', outcomes: 48, expectancy_lift_r: 0.18,
    }],
    executionQuality: { outcomes: 50, efficient_entry_rate: 72, poor_or_early_rate: 18 },
    ...overrides,
  };
}

const ictCandidate = {
  engine: 'ict', pair: 'EUR_USD', direction: 'long', session: 'London',
  marketRegime: 'trending', volatilityState: 'expanding',
  dailyDirection: 'bullish', h4Direction: 'bullish', confidence: 80,
  confirmations: { liquiditySweep: true },
};

test('keeps engine profiles isolated from other engines', () => {
  const result = computeEngineTradeAdjustment(
    { ...ictCandidate, engine: 'ppr' },
    matureProfile(),
  );
  assert.equal(result.scopeMatches, false);
  assert.equal(result.appliedAdjustment, 0);
});

test('keeps immature evidence in shadow and applies no live adjustment', () => {
  const result = computeEngineTradeAdjustment(
    ictCandidate,
    matureProfile({ pairSummary: { outcomes: 18, expectancy_r: 0.8 } }),
  );
  assert.equal(result.stage, 'shadow');
  assert.equal(result.rawAdjustment > 0, true);
  assert.equal(result.appliedAdjustment, 0);
});

test('applies bounded mature engine evidence to the matching trade only', () => {
  const result = computeEngineTradeAdjustment(ictCandidate, matureProfile());
  assert.equal(result.liveEligible, true);
  assert.equal(result.appliedAdjustment > 0, true);
  assert.equal(result.appliedAdjustment <= 3, true);
  assert.equal(result.hardGatesPreserved, true);
});

test('negative engine evidence reduces confidence but cannot exceed the cap', () => {
  const result = computeEngineTradeAdjustment(ictCandidate, matureProfile({
    pairSummary: { outcomes: 160, expectancy_r: -0.8 },
    contextStats: [{ direction: 'long', session: 'london', outcomes: 100, expectancy_r: -0.7 }],
    confirmationStats: [{ confirmation: 'liquidity_sweep', outcomes: 90, expectancy_lift_r: -0.4 }],
    executionQuality: { outcomes: 100, efficient_entry_rate: 15, poor_or_early_rate: 70 },
  }));
  assert.equal(result.appliedAdjustment < 0, true);
  assert.equal(result.appliedAdjustment >= -3, true);
});

test('combines market study and engine learning within a five-point total cap', () => {
  const result = applyBoundedConfidence({
    originalConfidence: 97,
    marketStudyAdjustment: 2,
    engineTradeAdjustment: 3,
  });
  assert.equal(result.combinedAdjustment, 5);
  assert.equal(result.finalConfidence, 100);

  const adverse = applyBoundedConfidence({
    originalConfidence: 4,
    marketStudyAdjustment: -2,
    engineTradeAdjustment: -3,
  });
  assert.equal(adverse.finalConfidence, 0);
});

test('late premium entry quality is penalized without creating a hard gate', () => {
  const quality = assessCandidateExecutionQuality({
    ...ictCandidate,
    timing: { timingGrade: 'D', lateEntryRisk: 'high' },
    concepts: {
      premiumDiscount: { currentZone: 'premium' },
      sweep: { pending: true, subtype: 'pending_sweep' },
    },
  });

  assert.equal(quality.adjustment < 0, true);
  assert.equal(quality.adjustment >= -2.5, true);
  assert.equal(quality.advisoryOnly, true);
  assert.equal(quality.createsHardGate, false);
  assert.equal(quality.adverseLocation, true);
  assert.equal(quality.sweepPending, true);
});

test('separates directional signal evidence from entry and fill quality', () => {
  const engineResult = computeEngineTradeAdjustment(ictCandidate, matureProfile({
    executionQuality: { outcomes: 100, efficient_entry_rate: 15, poor_or_early_rate: 70 },
  }));
  const separated = separateSignalAndExecutionLearning({
    engineResult,
    candidate: {
      ...ictCandidate,
      timing: { timingGrade: 'D', lateEntryRisk: 'high' },
      concepts: { premiumDiscount: { currentZone: 'premium' } },
    },
    options: { mode: 'limited', displayMinimum: 10, liveMinimum: 30, fullWeightMinimum: 100 },
  });

  assert.equal(separated.separated, true);
  assert.equal(separated.signalQuality.appliedAdjustment > 0, true);
  assert.equal(separated.executionQuality.appliedAdjustment < 0, true);
  assert.equal(separated.executionQuality.advisoryOnly, true);
  assert.equal(separated.executionQuality.createsHardGate, false);
});
