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
import {
  analyzeTradeLifecycle,
  computeBreakeven,
  computeMultiTargets,
  computePartialClosePlan,
  computeDynamicTrail,
  computeTrendExhaustion,
  computeCapitalEfficiency,
  pickUnifiedRecommendation,
} from './oandaTradeLifecycleEngine.js';
import { computeExpectedRR, classifyRRTier } from './oandaExpectedRR.js';

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
  // V3 update: a strong-trend trade in profit becomes break-even eligible, so
  // the unified recommendation correctly promotes hold → tighten_sl with the
  // break-even SL. expand_tp / hold are still acceptable when break-even is
  // not yet triggered.
  assert.ok(
    ['hold', 'expand_tp', 'tighten_sl'].includes(r.recommendation.action),
    `expected hold/expand_tp/tighten_sl, got ${r.recommendation.action}`,
  );
  // Dynamic TP should not contract under good conditions.
  assert.ok(
    r.dynamicTP.currentRecommendedTargetPips >= r.dynamicTP.baseTargetPips,
    'currentRecommendedTargetPips should not contract below base in strong trend',
  );
  // Break-even should be flagged eligible at ≥0.8R + improving momentum.
  assert.equal(r.breakeven.eligible, true);
});

// ── Signal Stack V3 — Expected RR ──────────────────────────────────────────

test('V3 RR tier classifier — premium / preferred / standard / reject', () => {
  assert.equal(classifyRRTier(4.0), 'premium');
  assert.equal(classifyRRTier(3.5), 'premium');
  assert.equal(classifyRRTier(2.5), 'preferred');
  assert.equal(classifyRRTier(2.0), 'standard');
  assert.equal(classifyRRTier(1.6), 'reject');
});

test('V3 expected-RR rejects geometry-only "good" trade with weak quality', () => {
  // Geometric RR = 3.0, but confidence is poor and market state disallowed.
  const r = computeExpectedRR({
    stopLossPips: 20,
    takeProfitPips: 60,
    confidence: 30,
    alignmentScore: 35,
    trendStrength: 30,
    volatilityRegime: 'compressed',
    marketState: 'RANGING',
    allowedMarketStates: ['TRENDING_BULL', 'TRENDING_BEAR'],
    institutionalFlow: { detected: true, direction: 'bearish' },
    direction: 'long',
    candleStrengthScore: 25,
  });
  assert.ok(r.expectedRR < 1.75, `expected RR <1.75, got ${r.expectedRR}`);
  assert.equal(r.rrTier, 'reject');
  assert.equal(r.accepted, false);
});

test('V3 expected-RR upgrades high-quality 3R setup to preferred/premium', () => {
  const r = computeExpectedRR({
    stopLossPips: 20,
    takeProfitPips: 60,
    confidence: 80,
    alignmentScore: 85,
    trendStrength: 80,
    volatilityRegime: 'normal',
    marketState: 'TRENDING_BULL',
    allowedMarketStates: ['TRENDING_BULL'],
    institutionalFlow: { detected: true, direction: 'bullish' },
    direction: 'long',
    candleStrengthScore: 80,
  });
  assert.ok(r.expectedRR >= 2.25, `expected preferred+, got ${r.expectedRR}`);
  assert.ok(['preferred', 'premium'].includes(r.rrTier));
  assert.equal(r.accepted, true);
});

// ── Signal Stack V3 — Break-even ────────────────────────────────────────────

test('V3 break-even: eligible when profit >= 0.8R and momentum not decaying', () => {
  const r = computeBreakeven({
    profitR: 0.9,
    momentumStatus: 'stable',
    side: 'long',
    entryPrice: 1.08,
    currentSL: 1.078,
    pipSize: 0.0001,
  });
  assert.equal(r.eligible, true);
  assert.equal(r.recommendedSL, 1.08);
});

test('V3 break-even: not eligible while momentum decaying', () => {
  const r = computeBreakeven({
    profitR: 1.2,
    momentumStatus: 'decaying',
    side: 'long',
    entryPrice: 1.08,
    currentSL: 1.078,
    pipSize: 0.0001,
  });
  assert.equal(r.eligible, false);
});

// ── Signal Stack V3 — Multi-target + partial close ──────────────────────────

test('V3 multi-targets: TP1/TP2/TP3 at 1R/2R/3R and currentStage tracks profit', () => {
  const mt = computeMultiTargets({
    riskPips: 20,
    side: 'long',
    entryPrice: 1.08,
    pipSize: 0.0001,
    profitPipsNow: 42,
  });
  assert.equal(mt.stages[0].pips, 20);
  assert.equal(mt.stages[1].pips, 40);
  assert.equal(mt.stages[2].pips, 60);
  assert.equal(mt.currentStage, 'TP2');
  const partial = computePartialClosePlan({ currentStage: mt.currentStage, momentumStatus: 'stable' });
  assert.equal(partial.recommendedPartialClosePercent, 25);
});

// ── Signal Stack V3 — Dynamic trail ─────────────────────────────────────────

test('V3 dynamic trail: expands when ATR rising, tightens when ATR falling, off below 0.8R', () => {
  const offBelow = computeDynamicTrail({
    atrPipsCurrent: 10, atrPipsAtEntry: 10, side: 'long', currentPrice: 1.0810, pipSize: 0.0001, profitR: 0.4,
  });
  assert.equal(offBelow.recommended, false);

  const expanding = computeDynamicTrail({
    atrPipsCurrent: 15, atrPipsAtEntry: 10, side: 'long', currentPrice: 1.0810, pipSize: 0.0001, profitR: 1.2,
  });
  assert.equal(expanding.recommended, true);
  assert.equal(expanding.multiplier, 2.0);

  const contracting = computeDynamicTrail({
    atrPipsCurrent: 7, atrPipsAtEntry: 10, side: 'long', currentPrice: 1.0810, pipSize: 0.0001, profitR: 1.2,
  });
  assert.equal(contracting.multiplier, 1.0);
});

// ── Signal Stack V3 — Trend exhaustion ──────────────────────────────────────

test('V3 trend exhaustion: ATR climax + decaying momentum + high profit → exhausted', () => {
  const r = computeTrendExhaustion({
    atrPipsCurrent: 25,
    atrPipsAtEntry: 9,
    profitR: 2.5,
    profitPipsNow: 50,
    momentumStatus: 'decaying',
    candleStrengthScore: 35,
    velocityScore: 88,
  });
  assert.equal(r.trendExhaustionStatus, 'exhausted');
  assert.ok(r.trendExhaustionScore >= 70);
});

test('V3 trend exhaustion: clean trade scores normal', () => {
  const r = computeTrendExhaustion({
    atrPipsCurrent: 10,
    atrPipsAtEntry: 9,
    profitR: 0.5,
    profitPipsNow: 8,
    momentumStatus: 'stable',
    candleStrengthScore: 70,
    velocityScore: 55,
  });
  assert.equal(r.trendExhaustionStatus, 'normal');
});

// ── Signal Stack V3 — Capital efficiency ────────────────────────────────────

test('V3 capital efficiency: fast trade in good state = Excellent or Good', () => {
  const r = computeCapitalEfficiency({
    velocityScore: 90,
    opportunityCostScore: 80,
    holdRatio: 0.5,
    marketStateAllowed: true,
    expectedRR: 2.5,
  });
  assert.ok(['Excellent', 'Good'].includes(r.capitalEfficiencyLabel));
});

test('V3 capital efficiency: stagnant past hold window in bad state = Poor/Exit Candidate', () => {
  const r = computeCapitalEfficiency({
    velocityScore: 10,
    opportunityCostScore: 25,
    holdRatio: 1.8,
    marketStateAllowed: false,
    expectedRR: 1.2,
  });
  assert.ok(['Poor', 'Exit Candidate'].includes(r.capitalEfficiencyLabel));
});

// ── Signal Stack V3 — Unified recommendation conflict surfacing ─────────────

test('V3 unified recommendation: improving momentum + invalidation → exit takes priority, conflict noted', () => {
  const unified = pickUnifiedRecommendation({
    baseRecommendation: {
      action: 'close',
      reason: 'Invalidated.',
      urgency: 'high',
      confidence: 90,
      suggestedNewSL: null,
      suggestedNewTP: 30,
      shouldAutoClose: false,
      autoCloseReason: null,
    },
    trendExhaustion: { trendExhaustionScore: 50, trendExhaustionStatus: 'extended' },
    capitalEfficiency: { capitalEfficiencyScore: 60, capitalEfficiencyLabel: 'Good' },
    breakeven: { eligible: false, recommendedSL: null, reason: '' },
    momentumStatus: 'improving',
    invalidationDetected: true,
    holdStatus: 'on_track',
    partialClosePercent: 0,
    multiTargets: { stages: [], currentStage: 'pre-TP1' },
  });
  assert.equal(unified.action, 'close');
  assert.ok(unified.conflictNotes.length > 0);
  assert.ok(unified.unifiedSummary.toLowerCase().includes('however'));
});

test('V3 unified recommendation: hold base + break-even eligible → tighten_sl with break-even reason', () => {
  const unified = pickUnifiedRecommendation({
    baseRecommendation: {
      action: 'hold',
      reason: 'Velocity 55/100, momentum stable.',
      urgency: 'low',
      confidence: 60,
      suggestedNewSL: null,
      suggestedNewTP: 30,
      shouldAutoClose: false,
      autoCloseReason: null,
    },
    trendExhaustion: { trendExhaustionScore: 10, trendExhaustionStatus: 'normal' },
    capitalEfficiency: { capitalEfficiencyScore: 65, capitalEfficiencyLabel: 'Good' },
    breakeven: { eligible: true, recommendedSL: 1.08, reason: 'Profit 0.9R, stable momentum.' },
    momentumStatus: 'stable',
    invalidationDetected: false,
    holdStatus: 'on_track',
    partialClosePercent: 0,
    multiTargets: { stages: [], currentStage: 'pre-TP1' },
  });
  assert.equal(unified.action, 'tighten_sl');
  assert.equal(unified.suggestedNewSL, 1.08);
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
