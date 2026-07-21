import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const schedulerSource = readFileSync(new URL('./ictAutoScheduler.js', import.meta.url), 'utf8');
const reassessorSource = readFileSync(new URL('./oandaActiveTradeReassessor.js', import.meta.url), 'utf8');
const routeSource = readFileSync(
  new URL('../web/app/api/cron/active-trade-management/route.ts', import.meta.url),
  'utf8',
);

test('ICT close-capable management has a hard 30-minute cadence without startup close review', () => {
  assert.match(
    schedulerSource,
    /ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS = Math\.max\(1800000, interval\('ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS', 1800000\)\)/,
  );
  assert.match(
    schedulerSource,
    /first close-capable review must occur on the 30-minute scheduler cadence/i,
  );
  assert.doesNotMatch(
    schedulerSource,
    /void activeTradeManagementTick\(nextUrl, secret\);\s*void transactionSyncTick/,
  );
});

test('generic reassessor cannot directly close broker trades', () => {
  assert.match(
    reassessorSource,
    /REASSESSMENT_INTERVAL_MS = Math\.max\(30 \* 60 \* 1000, Number\(process\.env\.ACTIVE_TRADE_REASSESS_INTERVAL_MS/,
  );
  assert.match(reassessorSource, /const DIRECT_REASSESSOR_BROKER_CLOSE_ENABLED = false/);
  assert.match(
    reassessorSource,
    /if \(DIRECT_REASSESSOR_BROKER_CLOSE_ENABLED && AUTO_CLOSE_ENABLED/,
  );
  assert.match(reassessorSource, /initialRiskPips: originalSlPips/);
  assert.match(reassessorSource, /currentStopLoss:/);
});

test('ICT route requires 30m age, HIGH reversal, explicit exit, and near-SL proximity', () => {
  assert.match(routeSource, /ICT_MIN_REASSESSMENT_AGE_MINUTES = 30/);
  assert.match(routeSource, /ICT_NEAR_SL_RISK_FRACTION = 0\.25/);
  assert.match(routeSource, /reassessmentDue &&\s*explicitHighReversal &&\s*explicitCloseRecommendation &&\s*closeToStop/);
  assert.match(routeSource, /lifecycleSource === 'thesis_invalidation'/);
  assert.match(routeSource, /lifecycleSource === 'institutional_reversal'/);
  assert.match(routeSource, /recommendedAction === 'EXIT_INVALIDATED'/);
  assert.doesNotMatch(routeSource, /export function shouldCloseIctTrade/);
  assert.doesNotMatch(
    routeSource.slice(
      routeSource.indexOf('function shouldCloseIctTrade'),
      routeSource.indexOf('// Preserve the existing V3 management policy'),
    ),
    /EXIT_REVIEW|confidence_breakdown|mediumOrHigherReversal|volatilityCollapsed/,
  );
  assert.match(routeSource, /tradeEngine === 'ict'\s*\? shouldCloseIctTrade\(plan\)/);
  assert.match(routeSource, /ict_30m_high_reversal_near_sl_only/);
});
