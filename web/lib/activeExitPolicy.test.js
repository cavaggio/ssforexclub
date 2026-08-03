import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateActiveExit, closeUnitsForDecision } from './activeExitPolicy.js';

const base = {
  profitRMultiple: 0.35,
  initialRiskPips: 10,
  distanceToSL: 12,
  tpProgress: 0.25,
  momentumDecayScore: 20,
  momentumStatus: 'stable',
  reversalRisk: 'low',
  invalidationDetected: false,
  marketState: 'TRENDING',
  direction: 'long',
};

test('original TP remains the default objective', () => {
  const decision = evaluateActiveExit(base);
  assert.equal(decision.action, 'HOLD_TO_TP');
  assert.equal(decision.preserveOriginalTakeProfit, true);
});

test('hard thesis invalidation closes the full trade immediately', () => {
  const decision = evaluateActiveExit({
    ...base,
    profitRMultiple: 0.8,
    invalidationDetected: true,
    invalidationSeverity: 'high',
  });
  assert.equal(decision.action, 'FULL_CLOSE');
  assert.equal(decision.closePercent, 100);
});

test('high reversal risk near breakeven triggers the minimal-loss rescue', () => {
  const decision = evaluateActiveExit({
    ...base,
    profitRMultiple: -0.15,
    reversalRisk: 'high',
    trendWeakeningDetected: true,
    momentumDecayScore: 75,
  });
  assert.equal(decision.metrics.currentProfitPips, -1.5);
  assert.equal(decision.action, 'FULL_CLOSE');
  assert.match(decision.reason, /minimal-loss rescue/i);
});

test('strong profitable breakout holds the full position for TP', () => {
  const decision = evaluateActiveExit({
    ...base,
    profitRMultiple: 1.1,
    tpProgress: 0.55,
    marketState: 'BREAKOUT',
    momentumDecayScore: 25,
    givebackPercent: 4,
  });
  assert.equal(decision.action, 'HOLD_TO_TP');
  assert.match(decision.reason, /breakout continuation remains strong/i);
});

test('weakening breakout takes one partial and preserves a runner', () => {
  const decision = evaluateActiveExit({
    ...base,
    profitRMultiple: 1.1,
    tpProgress: 0.55,
    marketState: 'BREAKOUT',
    momentumDecayScore: 58,
    reversalRisk: 'medium',
    partialExitPercent: 33,
  });
  assert.equal(decision.action, 'PARTIAL_CLOSE');
  assert.equal(decision.closePercent, 33);
  assert.equal(decision.preserveOriginalTakeProfit, true);
  assert.equal(closeUnitsForDecision(100000, decision), 33000);
});

test('the policy does not repeatedly partial-close the same trade', () => {
  const decision = evaluateActiveExit({
    ...base,
    profitRMultiple: 1.25,
    tpProgress: 0.75,
    momentumDecayScore: 60,
    reversalRisk: 'medium',
    partialExitPercent: 50,
  }, { priorPartialCount: 1 });
  assert.equal(decision.action, 'HOLD_TO_TP');
});

test('confirmed momentum peak closes the remaining profitable position', () => {
  const decision = evaluateActiveExit({
    ...base,
    profitRMultiple: 1.2,
    momentumDecayScore: 82,
    reversalRisk: 'medium',
    givebackPercent: 28,
  }, { priorPartialCount: 1, peakProfitR: 1.6, peakProfitPips: 16 });
  assert.equal(decision.action, 'FULL_CLOSE');
  assert.match(decision.reason, /momentum has peaked/i);
});

test('partial sizing always leaves at least one unit as the runner', () => {
  assert.equal(closeUnitsForDecision(2, { action: 'PARTIAL_CLOSE', closePercent: 50 }), 1);
  assert.equal(closeUnitsForDecision(1, { action: 'PARTIAL_CLOSE', closePercent: 50 }), null);
  assert.equal(closeUnitsForDecision(100, { action: 'FULL_CLOSE', closePercent: 100 }), 'ALL');
});
