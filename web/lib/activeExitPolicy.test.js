import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRST_PARTIAL_PROFIT_PIPS,
  evaluateActiveExit,
  closeUnitsForDecision,
} from './activeExitPolicy.js';

const base = {
  direction: 'long',
  entryPrice: 1.1,
  currentPrice: 1.1035,
  currentStopLoss: 1.097,
  profitRMultiple: 0.35,
  initialRiskPips: 10,
  tpProgress: 0.25,
  momentumDecayScore: 20,
  momentumStatus: 'stable',
  reversalRisk: 'low',
  invalidationDetected: false,
  marketState: 'TRENDING',
};

test('the first automatic partial milestone is fixed at 15 pips', () => {
  assert.equal(FIRST_PARTIAL_PROFIT_PIPS, 15);
});

test('the original broker SL/TP remain untouched before a protection milestone', () => {
  const decision = evaluateActiveExit(base);
  assert.equal(decision.action, 'HOLD_TO_TP');
  assert.equal(decision.automaticFullCloseAllowed, false);
  assert.equal(decision.cancelTakeProfit, false);
});

test('hard invalidation never becomes an automatic early liquidation', () => {
  const decision = evaluateActiveExit({
    ...base,
    currentPrice: 1.099,
    profitRMultiple: -0.1,
    invalidationDetected: true,
    invalidationSeverity: 'high',
  });
  assert.equal(decision.action, 'HOLD_TO_TP');
  assert.match(decision.reason, /protective SL remains the loss authority/i);
  assert.equal(closeUnitsForDecision(100000, decision), null);
});

test('high reversal risk near breakeven is recorded but not auto-closed', () => {
  const decision = evaluateActiveExit({
    ...base,
    currentPrice: 1.0985,
    profitRMultiple: -0.15,
    reversalRisk: 'high',
    trendWeakeningDetected: true,
    momentumDecayScore: 75,
  });
  assert.equal(decision.metrics.currentProfitPips, -1.5);
  assert.equal(decision.action, 'HOLD_TO_TP');
  assert.match(decision.reason, /automatic early liquidation is disabled/i);
});

test('near-target favorable momentum below 15 pips no longer takes an early partial', () => {
  const decision = evaluateActiveExit({
    ...base,
    currentPrice: 1.108,
    profitRMultiple: 0.8,
    tpProgress: 0.7,
    marketState: 'BREAKOUT',
    momentumDecayScore: 25,
  });
  assert.equal(decision.metrics.currentProfitPips, 8);
  assert.equal(decision.action, 'HOLD_TO_TP');
  assert.equal(decision.closePercent, 0);
});

test('exactly 15 pips banks a 50% partial even when 15 pips is less than 1R', () => {
  const decision = evaluateActiveExit({
    ...base,
    currentPrice: 1.1015,
    profitRMultiple: 0.75,
    initialRiskPips: 20,
    tpProgress: 0.4,
    momentumStatus: 'stable',
  });
  assert.equal(decision.metrics.currentProfitPips, 15);
  assert.equal(decision.action, 'PARTIAL_CLOSE');
  assert.equal(decision.closePercent, 50);
  assert.equal(decision.stopLoss, base.entryPrice);
  assert.equal(decision.cancelTakeProfit, true);
  assert.equal(closeUnitsForDecision(439743, decision), 219871);
});

test('15 pip milestone protects profit even if momentum has deteriorated', () => {
  const decision = evaluateActiveExit({
    ...base,
    currentPrice: 1.1015,
    profitRMultiple: 0.75,
    initialRiskPips: 20,
    tpProgress: 0.4,
    momentumStatus: 'reversal',
    reversalRisk: 'high',
    momentumDecayScore: 80,
  });
  assert.equal(decision.action, 'PARTIAL_CLOSE');
  assert.equal(decision.closePercent, 50);
  assert.equal(decision.automaticFullCloseAllowed, false);
});

test('+1R below 15 pips moves the stop to breakeven but does not take a partial', () => {
  const decision = evaluateActiveExit({
    ...base,
    currentPrice: 1.1011,
    profitRMultiple: 1.1,
    initialRiskPips: 10,
    tpProgress: 0.55,
    momentumStatus: 'accelerating',
  });
  assert.equal(decision.metrics.currentProfitPips, 11);
  assert.equal(decision.action, 'MOVE_STOP_TO_BREAKEVEN');
  assert.equal(decision.stopLoss, base.entryPrice);
  assert.equal(decision.closePercent, 0);
});

test('a banked partial is converted into a breakeven runner and cannot fire twice', () => {
  const decision = evaluateActiveExit({
    ...base,
    profitRMultiple: 1.8,
    initialRiskPips: 10,
  }, { priorPartialCount: 1 });
  assert.equal(decision.action, 'ARM_RUNNER');
  assert.equal(decision.stopLoss, base.entryPrice);
  assert.equal(decision.cancelTakeProfit, true);
  assert.equal(closeUnitsForDecision(100000, decision), null);
});

test('an armed runner waits for the original TP threshold before trailing', () => {
  const decision = evaluateActiveExit({ ...base, tpProgress: 0.95 }, {
    priorPartialCount: 1,
    runnerArmed: true,
    breakEvenSet: true,
  });
  assert.equal(decision.action, 'HOLD_TO_TP');
  assert.match(decision.reason, /wait for the original TP threshold/i);
});

test('after original TP is reached the runner trails profit without closing', () => {
  const decision = evaluateActiveExit({
    ...base,
    currentPrice: 1.13,
    profitRMultiple: 3,
    tpProgress: 1.08,
    recommendedStopLoss: 1.115,
  }, {
    priorPartialCount: 1,
    runnerArmed: true,
    breakEvenSet: true,
  });
  assert.equal(decision.action, 'TRAIL_PROFIT');
  assert.ok(decision.stopLoss > base.entryPrice);
  assert.equal(decision.cancelTakeProfit, true);
  assert.equal(closeUnitsForDecision(100000, decision), null);
});

test('partial sizing always leaves at least one runner unit and cannot express a full close', () => {
  assert.equal(closeUnitsForDecision(2, { action: 'PARTIAL_CLOSE', closePercent: 50 }), 1);
  assert.equal(closeUnitsForDecision(1, { action: 'PARTIAL_CLOSE', closePercent: 50 }), null);
  assert.equal(closeUnitsForDecision(100, { action: 'FULL_CLOSE', closePercent: 100 }), null);
});