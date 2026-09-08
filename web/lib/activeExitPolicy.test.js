import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRST_TAKE_PROFIT_PIPS,
  FIRST_PARTIAL_PERCENT,
  FINAL_TAKE_PROFIT_PIPS,
  FINAL_PARTIAL_PERCENT,
  FIXED_STOP_LOSS_PIPS,
  FIXED_RR,
  evaluateActiveExit,
  closeUnitsForDecision,
} from './activeExitPolicy.js';

const base = {
  direction: 'long',
  entryPrice: 1.1,
  currentPrice: 1.1035,
  currentStopLoss: 1.099,
  unrealizedPips: 3.5,
};

test('the hard-coded profit protection geometry is 10p SL / 80% at 15p / 20% at 18p', () => {
  assert.equal(FIXED_STOP_LOSS_PIPS, 10);
  assert.equal(FIRST_TAKE_PROFIT_PIPS, 15);
  assert.equal(FIRST_PARTIAL_PERCENT, 80);
  assert.equal(FINAL_TAKE_PROFIT_PIPS, 18);
  assert.equal(FINAL_PARTIAL_PERCENT, 20);
  assert.equal(FIXED_RR, 1.5);
});

test('before the first milestone the trade is held and no automatic full close is allowed', () => {
  const decision = evaluateActiveExit(base);
  assert.equal(decision.action, 'HOLD_TO_TP');
  assert.equal(decision.automaticFullCloseAllowed, false);
});

test('exactly +15 pips closes 80% and protects the remaining 20% at breakeven', () => {
  const decision = evaluateActiveExit({
    ...base,
    currentPrice: 1.1015,
    unrealizedPips: 15,
  });
  assert.equal(decision.action, 'PARTIAL_CLOSE');
  assert.equal(decision.closePercent, 80);
  assert.equal(decision.stopLoss, base.entryPrice);
  assert.equal(decision.cancelTakeProfit, true);
});

test('between +15 and +18 pips the remaining 20% is held at breakeven', () => {
  const decision = evaluateActiveExit({
    ...base,
    currentPrice: 1.1017,
    unrealizedPips: 17,
  }, {
    priorPartialCount: 1,
    breakEvenSet: true,
  });
  assert.equal(decision.action, 'HOLD_TO_TP');
  assert.equal(decision.automaticFullCloseAllowed, false);
  assert.match(decision.reason, /remaining 20%/i);
});

test('exactly +18 pips closes the remaining 20%', () => {
  const decision = evaluateActiveExit({
    ...base,
    currentPrice: 1.1018,
    unrealizedPips: 18,
  }, {
    priorPartialCount: 1,
    breakEvenSet: true,
  });
  assert.equal(decision.action, 'PARTIAL_CLOSE');
  assert.equal(decision.closePercent, 20);
  assert.equal(decision.stopLoss, base.entryPrice);
  assert.equal(decision.cancelTakeProfit, true);
});

test('a jump from below +15 directly through +18 still closes the intended remaining runner only after the first partial is known', () => {
  const decision = evaluateActiveExit({
    ...base,
    currentPrice: 1.102,
    unrealizedPips: 20,
  }, {
    priorPartialCount: 1,
    breakEvenSet: true,
  });
  assert.equal(decision.action, 'PARTIAL_CLOSE');
  assert.equal(decision.closePercent, 20);
});

test('negative price movement never triggers discretionary automatic liquidation', () => {
  const decision = evaluateActiveExit({
    ...base,
    currentPrice: 1.0985,
    unrealizedPips: -15,
  });
  assert.equal(decision.action, 'HOLD_TO_TP');
  assert.equal(decision.automaticFullCloseAllowed, false);
  assert.equal(closeUnitsForDecision(100000, decision), null);
});

test('partial sizing leaves a runner and cannot express a full close', () => {
  assert.equal(closeUnitsForDecision(100, { action: 'PARTIAL_CLOSE', closePercent: 80 }), 80);
  assert.equal(closeUnitsForDecision(100, { action: 'PARTIAL_CLOSE', closePercent: 20 }), 20);
  assert.equal(closeUnitsForDecision(100, { action: 'FULL_CLOSE', closePercent: 100 }), null);
  assert.equal(closeUnitsForDecision(1, { action: 'PARTIAL_CLOSE', closePercent: 80 }), null);
});
