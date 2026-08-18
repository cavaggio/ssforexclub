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

test('policy exposes only breakeven, one 15-pip partial, runner arming, trailing, or hold', () => {
  assert.match(policySource, /FIRST_PARTIAL_PROFIT_PIPS = 15/);
  assert.match(policySource, /currentProfitPips >= FIRST_PARTIAL_PROFIT_PIPS/);
  assert.match(policySource, /const percent = 50/);
  assert.match(policySource, /action: 'HOLD_TO_TP'/);
  assert.match(policySource, /action: 'MOVE_STOP_TO_BREAKEVEN'/);
  assert.match(policySource, /action: 'PARTIAL_CLOSE'/);
  assert.match(policySource, /action: 'ARM_RUNNER'/);
  assert.match(policySource, /action: 'TRAIL_PROFIT'/);
  assert.match(policySource, /priorPartialCount < 1/);
  assert.match(policySource, /automaticFullCloseAllowed: false/);
  assert.doesNotMatch(policySource, /action: 'FULL_CLOSE'/);
  assert.doesNotMatch(policySource, /return 'ALL'/);
});

test('hard invalidation and losing reversal defer to the broker SL', () => {
  const invalidated = evaluateActiveExit({
    direction: 'long', entryPrice: 1.1, currentPrice: 1.099,
    initialRiskPips: 10, profitRMultiple: -0.1, invalidationDetected: true,
  });
  assert.equal(invalidated.action, 'HOLD_TO_TP');

  const reversal = evaluateActiveExit({
    direction: 'long', entryPrice: 1.1, currentPrice: 1.0985,
    initialRiskPips: 10, profitRMultiple: -0.15, reversalRisk: 'high',
    trendWeakeningDetected: true, momentumDecayScore: 75,
  });
  assert.equal(reversal.action, 'HOLD_TO_TP');
  assert.equal(closeUnitsForDecision(100000, reversal), null);
});

test('the +15 pip milestone banks 50% once and the post-TP remainder trails', () => {
  const partial = evaluateActiveExit({
    direction: 'long', entryPrice: 1.1, currentPrice: 1.1015,
    initialRiskPips: 20, profitRMultiple: 0.75, tpProgress: 0.4,
    marketState: 'BREAKOUT', momentumDecayScore: 20, momentumStatus: 'accelerating',
  });
  assert.equal(partial.metrics.currentProfitPips, 15);
  assert.equal(partial.action, 'PARTIAL_CLOSE');
  assert.equal(partial.closePercent, 50);
  assert.equal(closeUnitsForDecision(100000, partial), 50000);

  const trail = evaluateActiveExit({
    direction: 'long', entryPrice: 1.1, currentPrice: 1.13,
    initialRiskPips: 10, profitRMultiple: 3, tpProgress: 1.05,
  }, { priorPartialCount: 1, runnerArmed: true, breakEvenSet: true });
  assert.equal(trail.action, 'TRAIL_PROFIT');
  assert.equal(closeUnitsForDecision(50000, trail), null);
});