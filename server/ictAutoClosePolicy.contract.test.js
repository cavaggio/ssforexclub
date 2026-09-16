import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateActiveExit, closeUnitsForDecision } from '../web/lib/activeExitPolicy.js';

const schedulerSource = readFileSync(new URL('./ictAutoScheduler.js', import.meta.url), 'utf8');
const reassessorSource = readFileSync(new URL('./oandaActiveTradeReassessor.js', import.meta.url), 'utf8');
const routeSource = readFileSync(
  new URL('../web/app/api/cron/active-trade-management/route.ts', import.meta.url),
  'utf8',
);
const policySource = readFileSync(
  new URL('../web/lib/activeExitPolicy.js', import.meta.url),
  'utf8',
);

test('profit protection reviews every five minutes from 02:15 to 17:30 ET', () => {
  assert.match(
    schedulerSource,
    /ACTIVE_TRADE_MANAGEMENT_WINDOW = \{ startMin: 135, endMin: 1050 \}/,
  );
  assert.match(
    schedulerSource,
    /ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS = Math\.max\(300000, interval\('ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS', 300000\)\)/,
  );
  assert.match(schedulerSource, /management=02:15–17:30_ET/);
  assert.match(schedulerSource, /five-minute scheduler cadence/i);
});

test('generic reassessor has no direct broker liquidation path', () => {
  assert.doesNotMatch(reassessorSource, /closeBrokerTrade/);
  assert.doesNotMatch(reassessorSource, /units: 'ALL'/);
  assert.match(reassessorSource, /automaticFullCloseEnabled: false/);
  assert.match(reassessorSource, /initialRiskPips: originalSlPips/);
  assert.match(reassessorSource, /currentStopLoss:/);
  assert.match(reassessorSource, /originalTargetReached: tpProgress >= 1/);
});

test('authenticated route only performs numeric partials or protection updates', () => {
  assert.match(routeSource, /\.eq\('auto_close_enabled', true\)/);
  assert.match(routeSource, /trade_exit_management_state/);
  assert.match(routeSource, /evaluateActiveExit/);
  assert.match(routeSource, /closeUnitsForDecision/);
  assert.match(routeSource, /decision\.action === 'PARTIAL_CLOSE'/);
  assert.match(routeSource, /\/api\/internal\/oanda\/protection/);
  assert.match(routeSource, /profitProtectionPolicy: ACTIVE_EXIT_POLICY/);
  assert.match(routeSource, /automaticFullCloseDisabled: true/);
  assert.match(routeSource, /outside_management_window_02:15-17:30_ET/);
  assert.doesNotMatch(routeSource, /units: 'ALL'/);
  assert.doesNotMatch(routeSource, /action: 'FULL_CLOSE'/);
});

test('policy exposes fixed 10p SL, +10p breakeven, 80%@15p and final 20%@18p', () => {
  assert.match(policySource, /FIXED_STOP_LOSS_PIPS = 10/);
  assert.match(policySource, /BREAK_EVEN_TRIGGER_PIPS = 10/);
  assert.match(policySource, /FIRST_TAKE_PROFIT_PIPS = 15/);
  assert.match(policySource, /FIRST_PARTIAL_PERCENT = 80/);
  assert.match(policySource, /FINAL_TAKE_PROFIT_PIPS = 18/);
  assert.match(policySource, /FINAL_PARTIAL_PERCENT = 20/);
  assert.match(policySource, /FIXED_RR = 1\.56/);
  assert.match(policySource, /action: 'HOLD_TO_TP'/);
  assert.match(policySource, /action: 'MOVE_STOP_TO_BREAKEVEN'/);
  assert.match(policySource, /action: 'PARTIAL_CLOSE'/);
  assert.match(policySource, /automaticFullCloseAllowed: false/);
  assert.doesNotMatch(policySource, /action: 'FULL_CLOSE'/);
  assert.doesNotMatch(policySource, /return 'ALL'/);
});

test('hard invalidation and losing reversal defer to the broker SL', () => {
  const invalidated = evaluateActiveExit({
    direction: 'long', entryPrice: 1.1, currentPrice: 1.099,
    unrealizedPips: -10, initialRiskPips: 10, profitRMultiple: -0.1, invalidationDetected: true,
  });
  assert.equal(invalidated.action, 'HOLD_TO_TP');

  const reversal = evaluateActiveExit({
    direction: 'long', entryPrice: 1.1, currentPrice: 1.0985,
    unrealizedPips: -15, initialRiskPips: 10, profitRMultiple: -0.15, reversalRisk: 'high',
    trendWeakeningDetected: true, momentumDecayScore: 75,
  });
  assert.equal(reversal.action, 'HOLD_TO_TP');
  assert.equal(closeUnitsForDecision(100000, reversal), null);
});

test('+10 pips moves protection to breakeven without closing units', () => {
  const decision = evaluateActiveExit({
    direction: 'long', entryPrice: 1.1, unrealizedPips: 10,
  });
  assert.equal(decision.action, 'MOVE_STOP_TO_BREAKEVEN');
  assert.equal(decision.stopLoss, 1.1);
  assert.equal(closeUnitsForDecision(100000, decision), null);
});

test('+15 pips banks 80% once', () => {
  const partial = evaluateActiveExit({
    direction: 'long', entryPrice: 1.1, unrealizedPips: 15,
  });
  assert.equal(partial.metrics.currentProfitPips, 15);
  assert.equal(partial.action, 'PARTIAL_CLOSE');
  assert.equal(partial.closePercent, 80);
  assert.equal(closeUnitsForDecision(100000, partial), 80000);
});

test('after the 80% partial, the remaining 20% holds protected until +18 pips', () => {
  const hold = evaluateActiveExit({
    direction: 'long', entryPrice: 1.1, unrealizedPips: 16,
  }, { firstPartialTaken: true, priorPartialCount: 1, breakEvenSet: true });
  assert.equal(hold.action, 'HOLD_TO_TP');
  assert.equal(closeUnitsForDecision(20000, hold), null);

  const final = evaluateActiveExit({
    direction: 'long', entryPrice: 1.1, unrealizedPips: 18,
  }, { firstPartialTaken: true, priorPartialCount: 1, breakEvenSet: true });
  assert.equal(final.action, 'PARTIAL_CLOSE');
  assert.equal(final.closePercent, 20);
  assert.equal(closeUnitsForDecision(20000, final), 4000);
});
