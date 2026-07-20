import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketAlignedRecommendation } from './oandaActiveTradeReassessor.js';

const base = {
  action: 'hold',
  urgency: 'low',
  confidence: 60,
  reason: 'Base lifecycle hold.',
  unifiedSummary: 'Base lifecycle hold.',
  suggestedNewSL: null,
  suggestedNewTP: 30,
  shouldAutoClose: false,
  autoCloseReason: null,
};

test('confidence below 70 plus live signal misalignment creates a close review', () => {
  const result = buildMarketAlignedRecommendation({
    baseRecommendation: base,
    currentConfidence: 64,
    confidenceThreshold: 70,
    signalMisalignmentReasons: [
      'institutional flow opposes the open position',
      'the M15 trend reversed against the position',
    ],
    flowOpposes: true,
    m15TrendReversed: true,
    profitR: -0.1,
    liveAutoCloseEnabled: false,
  });

  assert.equal(result.action, 'close');
  assert.equal(result.urgency, 'high');
  assert.equal(result.autoCloseCandidate, true);
  assert.equal(result.shouldAutoClose, false);
  assert.equal(result.confidenceBelowThreshold, true);
  assert.match(result.unifiedSummary, /Close review is high priority/i);
});

test('auto-close is armed only when high-priority close evidence and the guard are both present', () => {
  const result = buildMarketAlignedRecommendation({
    baseRecommendation: base,
    currentConfidence: 48,
    confidenceThreshold: 70,
    signalMisalignmentReasons: ['multi-timeframe direction is conflicting'],
    profitR: -0.2,
    liveAutoCloseEnabled: true,
  });

  assert.equal(result.action, 'close');
  assert.equal(result.urgency, 'high');
  assert.equal(result.shouldAutoClose, true);
  assert.match(result.autoCloseReason, /confidence_below/i);
});

test('confidence below 70 without contradictory market evidence triggers review, not forced close', () => {
  const result = buildMarketAlignedRecommendation({
    baseRecommendation: base,
    currentConfidence: 66,
    confidenceThreshold: 70,
    signalMisalignmentReasons: [],
    profitR: 0.1,
    liveAutoCloseEnabled: true,
  });

  assert.equal(result.action, 'hold');
  assert.equal(result.urgency, 'medium');
  assert.equal(result.autoCloseCandidate, false);
  assert.equal(result.shouldAutoClose, false);
  assert.match(result.unifiedSummary, /not yet enough contradictory market evidence/i);
});

test('healthy confidence and aligned market preserve the existing lifecycle recommendation', () => {
  const result = buildMarketAlignedRecommendation({
    baseRecommendation: { ...base, action: 'tighten_sl', urgency: 'low' },
    currentConfidence: 82,
    confidenceThreshold: 70,
    signalMisalignmentReasons: [],
    profitR: 0.9,
    liveAutoCloseEnabled: true,
  });

  assert.equal(result.action, 'tighten_sl');
  assert.equal(result.autoCloseReviewTriggered, false);
  assert.equal(result.shouldAutoClose, false);
});
