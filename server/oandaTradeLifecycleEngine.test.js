/**
 * server/oandaTradeLifecycleEngine.test.js
 *
 * node:test scenarios that pin the lifecycle engine's behaviour for the
 * five canonical trade shapes the user asked about:
 *
 *   1. Fast winning trade   → expand TP / hold
 *   2. Slow stagnant trade  → tighten SL / reduce TP
 *   3. Expired weak trade   → close recommendation
 *   4. Momentum reversal    → partial close or close
 *   5. Strong trend         → hold / expand TP
 *
 * Run with:   node --test server/oandaTradeLifecycleEngine.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTradeLifecycle } from './oandaTradeLifecycleEngine.js';

const baseCtx = {
  pair: 'EUR_USD',
  tradeId: 'T1',
  side: 'long',
  entryPrice: 1.0800,
  currentPrice: 1.0810,
  currentSL: 1.0790,
  originalTpPips: 30,
  pipSize: 0.0001,
  spreadPips: 1.0,
  maxSpreadPips: 3,
  marketStateAllowed: true,
  liveAutoCloseEnabled: false,
};

test('1. fast winning trade → expand TP, low urgency', () => {
  const ctx = {
    ...baseCtx,
    minutesElapsed: 20,
    expectedHoldTimeMinutes: 60,
    profitR: 1.6,
    profitPipsNow: 24,
    tpProgress: 0.80,
    entryAlignmentScore: 72,
    currentAlignmentScore: 78,
    entryMtfScore: 70,
    currentMtfScore: 75,
    candleStrengthScore: 75,
    atrPipsAtEntry: 8,
    atrPipsCurrent: 10,
    mtfConflict: false,
    flowOpposes: false,
    flowMatchesDirection: true,
    m15TrendReversed: false,
    volatilityCollapsed: false,
    invalidationDetected: false,
    currentConfidence: 75,
  };
  const r = analyzeTradeLifecycle(ctx);
  assert.equal(r.holdStatus, 'on_track');
  assert.ok(r.velocityScore >= 75, `velocityScore expected >=75, got ${r.velocityScore}`);
  assert.equal(r.momentumStatus, 'improving');
  assert.equal(r.recommendation.action, 'expand_tp');
  assert.equal(r.recommendation.urgency, 'low');
  assert.equal(r.recommendation.shouldAutoClose, false);
  assert.ok(
    r.recommendation.suggestedNewTP >= r.dynamicTP.currentRecommendedTargetPips,
    'suggestedNewTP should not retreat below current recommendation',
  );
});

test('2. slow stagnant trade → tighten SL after holding profit', () => {
  const ctx = {
    ...baseCtx,
    minutesElapsed: 45,
    expectedHoldTimeMinutes: 60,
    profitR: 0.6,
    profitPipsNow: 9,
    tpProgress: 0.30,
    entryAlignmentScore: 70,
    currentAlignmentScore: 55,
    entryMtfScore: 65,
    currentMtfScore: 55,
    candleStrengthScore: 45,
    atrPipsAtEntry: 9,
    atrPipsCurrent: 6,
    mtfConflict: false,
    flowOpposes: false,
    flowMatchesDirection: false,
    m15TrendReversed: false,
    volatilityCollapsed: false,
    invalidationDetected: false,
    currentConfidence: 55,
  };
  const r = analyzeTradeLifecycle(ctx);
  assert.ok(r.velocityScore < 35, `velocityScore expected <35 (stagnant), got ${r.velocityScore}`);
  assert.equal(r.holdStatus, 'slow');
  assert.ok(
    ['tighten_sl', 'reduce_tp'].includes(r.recommendation.action),
    `expected tighten_sl or reduce_tp, got ${r.recommendation.action}`,
  );
  assert.equal(r.recommendation.urgency, 'medium');
  assert.equal(r.recommendation.shouldAutoClose, false);
});

test('3. expired weak trade → close recommendation, high urgency', () => {
  const ctx = {
    ...baseCtx,
    minutesElapsed: 90,
    expectedHoldTimeMinutes: 60,
    profitR: -0.2,
    profitPipsNow: -3,
    tpProgress: 0,
    entryAlignmentScore: 70,
    currentAlignmentScore: 40,
    entryMtfScore: 65,
    currentMtfScore: 45,
    candleStrengthScore: 35,
    atrPipsAtEntry: 9,
    atrPipsCurrent: 5,
    mtfConflict: false,
    flowOpposes: false,
    flowMatchesDirection: false,
    m15TrendReversed: false,
    volatilityCollapsed: true,
    invalidationDetected: false,
    currentConfidence: 40,
  };
  const r = analyzeTradeLifecycle(ctx);
  assert.equal(r.holdStatus, 'expired');
  assert.equal(r.recommendation.action, 'close');
  assert.equal(r.recommendation.urgency, 'high');
  // Auto-close stays false because we passed liveAutoCloseEnabled=false.
  assert.equal(r.recommendation.shouldAutoClose, false);
});

test('3b. expired weak trade with auto-close flag on → shouldAutoClose=true', () => {
  const ctx = {
    ...baseCtx,
    liveAutoCloseEnabled: true,
    minutesElapsed: 90,
    expectedHoldTimeMinutes: 60,
    profitR: -0.2,
    profitPipsNow: -3,
    tpProgress: 0,
    entryAlignmentScore: 70,
    currentAlignmentScore: 40,
    entryMtfScore: 65,
    currentMtfScore: 45,
    candleStrengthScore: 35,
    atrPipsAtEntry: 9,
    atrPipsCurrent: 5,
    mtfConflict: false,
    flowOpposes: false,
    flowMatchesDirection: false,
    m15TrendReversed: false,
    volatilityCollapsed: true,
    invalidationDetected: false,
    currentConfidence: 40,
  };
  const r = analyzeTradeLifecycle(ctx);
  assert.equal(r.recommendation.action, 'close');
  assert.equal(r.recommendation.urgency, 'high');
  assert.equal(r.recommendation.shouldAutoClose, true);
  assert.ok(typeof r.recommendation.autoCloseReason === 'string');
});

test('4. momentum reversal → partial close (when profit banked) or close', () => {
  const ctx = {
    ...baseCtx,
    minutesElapsed: 30,
    expectedHoldTimeMinutes: 60,
    profitR: 1.2,
    profitPipsNow: 18,
    tpProgress: 0.6,
    entryAlignmentScore: 75,
    currentAlignmentScore: 40,
    entryMtfScore: 80,
    currentMtfScore: 35,
    candleStrengthScore: 25,
    atrPipsAtEntry: 9,
    atrPipsCurrent: 8,
    mtfConflict: true,
    flowOpposes: true,
    flowMatchesDirection: false,
    m15TrendReversed: true,
    volatilityCollapsed: false,
    invalidationDetected: false,
    currentConfidence: 45,
  };
  const r = analyzeTradeLifecycle(ctx);
  assert.equal(r.momentumStatus, 'decaying');
  assert.ok(r.momentumDecayScore >= 60, `expected decay >=60, got ${r.momentumDecayScore}`);
  assert.ok(
    ['partial_close', 'close'].includes(r.recommendation.action),
    `expected partial_close or close, got ${r.recommendation.action}`,
  );
});

test('5. strong trend continuation → hold or expand TP', () => {
  const ctx = {
    ...baseCtx,
    minutesElapsed: 35,
    expectedHoldTimeMinutes: 60,
    profitR: 1.0,
    profitPipsNow: 18,
    tpProgress: 0.55,
    entryAlignmentScore: 78,
    currentAlignmentScore: 82,
    entryMtfScore: 78,
    currentMtfScore: 85,
    candleStrengthScore: 80,
    atrPipsAtEntry: 8,
    atrPipsCurrent: 11,
    mtfConflict: false,
    flowOpposes: false,
    flowMatchesDirection: true,
    m15TrendReversed: false,
    volatilityCollapsed: false,
    invalidationDetected: false,
    currentConfidence: 80,
  };
  const r = analyzeTradeLifecycle(ctx);
  assert.equal(r.momentumStatus, 'improving');
  assert.ok(
    ['hold', 'expand_tp'].includes(r.recommendation.action),
    `expected hold or expand_tp, got ${r.recommendation.action}`,
  );
  // Dynamic TP should not contract under good conditions.
  assert.ok(
    r.dynamicTP.currentRecommendedTargetPips >= r.dynamicTP.baseTargetPips,
    'currentRecommendedTargetPips should not contract below base in strong trend',
  );
});

test('invalidation flag → close with high urgency regardless of velocity', () => {
  const ctx = {
    ...baseCtx,
    minutesElapsed: 10,
    expectedHoldTimeMinutes: 60,
    profitR: 1.5,
    profitPipsNow: 22,
    tpProgress: 0.7,
    entryAlignmentScore: 75,
    currentAlignmentScore: 75,
    entryMtfScore: 70,
    currentMtfScore: 70,
    candleStrengthScore: 70,
    atrPipsAtEntry: 9,
    atrPipsCurrent: 9,
    mtfConflict: false,
    flowOpposes: false,
    flowMatchesDirection: true,
    m15TrendReversed: false,
    volatilityCollapsed: false,
    invalidationDetected: true,
    invalidationReason: 'HTF macro flip',
    currentConfidence: 75,
  };
  const r = analyzeTradeLifecycle(ctx);
  assert.equal(r.holdStatus, 'invalidated');
  assert.equal(r.recommendation.action, 'close');
  assert.equal(r.recommendation.urgency, 'high');
});
