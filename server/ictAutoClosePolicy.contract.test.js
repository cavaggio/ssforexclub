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

test('active exit management reviews every five minutes from 02:15 to 17:30 ET', () => {
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

test('generic reassessor remains recommendation-only', () => {
  assert.match(reassessorSource, /const DIRECT_REASSESSOR_BROKER_CLOSE_ENABLED = false/);
  assert.match(
    reassessorSource,
    /if \(DIRECT_REASSESSOR_BROKER_CLOSE_ENABLED && AUTO_CLOSE_ENABLED/,
  );
  assert.match(reassessorSource, /initialRiskPips: originalSlPips/);
  assert.match(reassessorSource, /currentStopLoss:/);
});

test('authenticated route is controlled by the per-user auto-close toggle', () => {
  assert.match(routeSource, /\.eq\('auto_close_enabled', true\)/);
  assert.match(routeSource, /trade_exit_management_state/);
  assert.match(routeSource, /evaluateActiveExit/);
  assert.match(routeSource, /closeUnitsForDecision/);
  assert.match(routeSource, /decision\.action === 'PARTIAL_CLOSE'/);
  assert.match(routeSource, /active_exit_intelligence_v1/);
  assert.match(routeSource, /outside_management_window_02:15-17:30_ET/);
  assert.doesNotMatch(routeSource, /ict_30m_high_reversal_near_sl_only/);
});

test('ICT exit policy prioritizes TP, limits partials, and supports loss rescue', () => {
  assert.match(policySource, /action: 'HOLD_TO_TP'/);
  assert.match(policySource, /priorPartialCount < 1/);
  assert.match(policySource, /lossRescueZone/);
  assert.match(policySource, /currentProfitPips >= -2/);
  assert.match(policySource, /action: 'PARTIAL_CLOSE'/);
  assert.match(policySource, /action: 'FULL_CLOSE'/);
  assert.match(policySource, /strongBreakoutContinuation/);
});

test('active policy holds strong continuation and protects a weakening breakout', () => {
  const strong = evaluateActiveExit({
    direction: 'long', initialRiskPips: 10, profitRMultiple: 1.1,
    tpProgress: 0.55, marketState: 'BREAKOUT', momentumDecayScore: 25,
    momentumStatus: 'stable', reversalRisk: 'low', givebackPercent: 4,
  });
  assert.equal(strong.action, 'HOLD_TO_TP');

  const weakening = evaluateActiveExit({
    direction: 'long', initialRiskPips: 10, profitRMultiple: 1.1,
    tpProgress: 0.55, marketState: 'BREAKOUT', momentumDecayScore: 58,
    momentumStatus: 'decaying', reversalRisk: 'medium', partialExitPercent: 33,
  });
  assert.equal(weakening.action, 'PARTIAL_CLOSE');
  assert.equal(weakening.closePercent, 33);
  assert.equal(closeUnitsForDecision(100000, weakening), 33000);
});

test('active policy closes hard invalidation and near-breakeven reversal risk', () => {
  const invalidated = evaluateActiveExit({
    initialRiskPips: 10, profitRMultiple: 0.7, invalidationDetected: true,
  });
  assert.equal(invalidated.action, 'FULL_CLOSE');

  const rescue = evaluateActiveExit({
    initialRiskPips: 10, profitRMultiple: -0.15, reversalRisk: 'high',
    trendWeakeningDetected: true, momentumDecayScore: 75,
  });
  assert.equal(rescue.metrics.currentProfitPips, -1.5);
  assert.equal(rescue.action, 'FULL_CLOSE');
});
