/**
 * server/oandaTradeLifecycleEngine.js
 *
 * Dynamic trade lifecycle engine. Takes the per-trade context the reassessor
 * already gathers (waterfall + entry context + lifecycle history) and emits a
 * professional-style management view:
 *
 *   - velocityScore               0–100  (actual pace vs expected pace)
 *   - momentumDecayScore          0–100  (higher = more decay)
 *   - momentumStatus              improving / stable / decaying
 *   - holdStatus                  on_track / slow / expired / invalidated
 *   - expectedRemainingHoldTime   minutes
 *   - dynamicTP                   { min / base / max / currentRecommended } pips
 *   - opportunityCostScore        0–100  (would we re-enter now?)
 *   - recommendation              action / reason / urgency / confidence /
 *                                 suggestedNewSL / suggestedNewTP /
 *                                 shouldAutoClose / autoCloseReason
 *   - logLine                     [TRADE_LIFECYCLE] one-liner for Railway logs
 *
 * This module is pure (no I/O, no env reads). The caller (the reassessor)
 * passes in everything the engine needs, including the auto-close env flag
 * resolved by the caller. That keeps the engine unit-testable and trivially
 * mockable.
 */

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const finite = (n, fallback = 0) => (Number.isFinite(n) ? n : fallback);
const round = (n) => Math.round(n);

/**
 * Velocity = how fast the trade is moving toward TP relative to plan.
 *
 *   expectedProgress = minutesElapsed / expectedHoldTimeMinutes
 *   actualProgress   = tpProgress (0..1 from entry → TP)
 *   ratio            = actualProgress / max(expectedProgress, 0.05)
 *   velocityScore    = clamp(round(50 * ratio), 0, 100)
 *
 * 100 = trade is reaching TP twice as fast as planned.
 *  50 = on pace.
 *   0 = no progress / moving against entry.
 */
export function computeVelocityScore({
  minutesElapsed,
  expectedHoldTimeMinutes,
  tpProgress,
  profitR,
}) {
  const elapsed = Math.max(0, finite(minutesElapsed, 0));
  const expected = Math.max(1, finite(expectedHoldTimeMinutes, 60));
  const expectedProgress = clamp(elapsed / expected, 0, 2);
  const actualProgress = clamp(finite(tpProgress, 0), 0, 1);
  // If the trade is in drawdown (profitR < 0) cap velocity well below 50 so
  // the rest of the engine treats it as stalled even if expectedProgress is
  // still small. The negative-progress floor stops tpProgress=0 from looking
  // identical to a healthy stalled-but-flat trade.
  if (finite(profitR, 0) < 0) {
    const drawdownPenalty = Math.min(40, Math.abs(profitR) * 30);
    return clamp(round(20 - drawdownPenalty), 0, 100);
  }
  const ratio = actualProgress / Math.max(expectedProgress, 0.05);
  return clamp(round(50 * ratio), 0, 100);
}

/**
 * Momentum decay = how much of the original entry edge has eroded.
 * Higher score = more decay (bad). Weights chosen so a single bad signal
 * can't push past ~50; multiple signals stacking push toward 100.
 */
export function computeMomentumDecay({
  entryAlignmentScore,
  currentAlignmentScore,
  entryMtfScore,
  currentMtfScore,
  candleStrengthScore,
  atrPipsAtEntry,
  atrPipsCurrent,
  mtfConflict,
  flowOpposes,
  m15TrendReversed,
}) {
  const alignmentDrop = Math.max(
    0,
    finite(entryAlignmentScore, finite(currentAlignmentScore, 50)) - finite(currentAlignmentScore, 50),
  );
  const mtfDrop = Math.max(
    0,
    finite(entryMtfScore, finite(currentMtfScore, 50)) - finite(currentMtfScore, 50),
  );
  // Candle weakness: under 50/100 contributes proportionally to decay.
  const candleWeakness = Math.max(0, 50 - finite(candleStrengthScore, 50));
  // ATR contraction: a 50% atr drop from entry contributes ~25 points.
  const atrEntry = finite(atrPipsAtEntry, 0);
  const atrNow = finite(atrPipsCurrent, atrEntry);
  const atrContractionRatio = atrEntry > 0 ? Math.max(0, 1 - atrNow / atrEntry) : 0;
  const atrContraction = clamp(atrContractionRatio * 50, 0, 50);
  const reversalPressure =
    (mtfConflict ? 25 : 0) + (flowOpposes ? 20 : 0) + (m15TrendReversed ? 15 : 0);

  const score = clamp(
    round(
      alignmentDrop * 0.35 +
        mtfDrop * 0.20 +
        candleWeakness * 0.5 + // already 0..50 → contributes up to 25
        atrContraction +       // 0..50
        reversalPressure,      // 0..60
    ),
    0,
    100,
  );
  const status = score < 25 ? 'improving' : score < 60 ? 'stable' : 'decaying';
  return { momentumDecayScore: score, momentumStatus: status };
}

/**
 * Hold status — categorical lifecycle stage based on elapsed/expected time
 * and velocity. Returns the expected remaining hold time as well.
 */
export function computeHoldStatus({
  minutesElapsed,
  expectedHoldTimeMinutes,
  velocityScore,
  invalidationDetected,
}) {
  const elapsed = Math.max(0, finite(minutesElapsed, 0));
  const expected = Math.max(1, finite(expectedHoldTimeMinutes, 60));
  const ratio = elapsed / expected;
  const expectedRemainingHoldTime = Math.max(0, Math.round(expected - elapsed));

  if (invalidationDetected) {
    return { holdStatus: 'invalidated', expectedRemainingHoldTime, holdRatio: +ratio.toFixed(2) };
  }
  if (ratio > 1.0) {
    return { holdStatus: 'expired', expectedRemainingHoldTime, holdRatio: +ratio.toFixed(2) };
  }
  if (ratio > 0.6 && velocityScore < 35) {
    return { holdStatus: 'slow', expectedRemainingHoldTime, holdRatio: +ratio.toFixed(2) };
  }
  if (velocityScore >= 50) {
    return { holdStatus: 'on_track', expectedRemainingHoldTime, holdRatio: +ratio.toFixed(2) };
  }
  return { holdStatus: 'slow', expectedRemainingHoldTime, holdRatio: +ratio.toFixed(2) };
}

/**
 * Dynamic TP envelope. Returns min/base/max in pips plus the currently
 * recommended TP. Recommendation moves toward max when velocity + momentum
 * + ATR expansion all agree, and toward min when they all disagree.
 */
export function computeDynamicTP({
  originalTpPips,
  velocityScore,
  momentumDecayScore,
  atrPipsAtEntry,
  atrPipsCurrent,
  profitPipsNow,
  volatilityCollapsed,
}) {
  const base = Math.max(1, finite(originalTpPips, 30));
  const min = Math.round(base * 0.5);
  const max = Math.round(base * 1.8);

  const velocityFactor = (finite(velocityScore, 50) - 50) / 100;            // -0.5..+0.5
  const momentumFactor = (50 - finite(momentumDecayScore, 50)) / 100;       // -0.5..+0.5
  const atrEntry = finite(atrPipsAtEntry, 0);
  const atrNow = finite(atrPipsCurrent, atrEntry);
  const atrFactor = atrEntry > 0 ? clamp(atrNow / atrEntry - 1, -0.6, 0.8) : 0;

  let adjustment = velocityFactor * 0.4 + momentumFactor * 0.35 + atrFactor * 0.25;
  if (volatilityCollapsed) adjustment -= 0.2;

  let current = Math.round(base * (1 + adjustment));
  current = clamp(current, min, max);
  // Never recommend a TP behind the trade's current realised profit.
  if (Number.isFinite(profitPipsNow) && profitPipsNow > 0) {
    current = Math.max(current, Math.round(profitPipsNow + 1));
  }
  return {
    minTargetPips: min,
    baseTargetPips: base,
    maxTargetPips: max,
    currentRecommendedTargetPips: current,
  };
}

/**
 * Opportunity cost — "if this trade was not already open, would we still
 * enter it now?" 100 = strong re-entry signal, 0 = no setup.
 */
export function computeOpportunityCost({
  currentAlignmentScore,
  currentConfidence,
  currentMtfScore,
  candleStrengthScore,
  marketStateAllowed,
  spreadPips,
  maxSpreadPips,
  flowMatchesDirection,
  tpProgress,
}) {
  const alignment = finite(currentAlignmentScore, 50);
  const confidence = finite(currentConfidence, 50);
  const mtf = finite(currentMtfScore, 50);
  const candle = finite(candleStrengthScore, 50);
  const quality = alignment * 0.30 + confidence * 0.20 + mtf * 0.20 + candle * 0.20;
  const stateBoost = marketStateAllowed ? 5 : -10;

  const spreadRatio =
    finite(maxSpreadPips, 1) > 0 ? finite(spreadPips, 0) / finite(maxSpreadPips, 1) : 0;
  const spreadPenalty = clamp(spreadRatio, 0, 1) * 15;
  const flowBoost = flowMatchesDirection ? 5 : -5;
  // Distance from entry — if the trade is mostly to TP already, opportunity
  // to re-enter is lower (we'd be entering late).
  const distanceFactor = (1 - clamp(finite(tpProgress, 0), 0, 1)) * 10;

  return clamp(
    Math.round(quality + stateBoost - spreadPenalty + flowBoost + distanceFactor),
    0,
    100,
  );
}

/**
 * Pick a management recommendation by folding velocity, momentum decay,
 * hold status, dynamic TP, and opportunity cost. Output mirrors the spec.
 */
export function pickRecommendation({
  velocityScore,
  momentumDecayScore,
  momentumStatus,
  holdStatus,
  opportunityCostScore,
  dynamicTP,
  profitR,
  tpProgress,
  pipSize,
  side,
  entryPrice,
  currentSL,
  atrPipsCurrent,
  invalidationDetected,
  invalidationReason,
  liveAutoCloseEnabled,
  opportunityCostExitThreshold = 35,
}) {
  const reasons = [];
  let action = 'hold';
  let urgency = 'low';
  let confidence = 60;
  let suggestedNewTP = dynamicTP.currentRecommendedTargetPips;
  let suggestedNewSL = currentSL ?? null;
  let shouldAutoClose = false;
  let autoCloseReason = null;

  // Hard exits first.
  if (invalidationDetected) {
    action = 'close';
    urgency = 'high';
    confidence = 90;
    reasons.push(`Invalidation detected: ${invalidationReason ?? 'thesis broken'}`);
    autoCloseReason = `invalidation:${invalidationReason ?? 'thesis broken'}`;
  } else if (holdStatus === 'invalidated') {
    action = 'close';
    urgency = 'high';
    confidence = 85;
    reasons.push('Hold status invalidated — trade thesis no longer holds.');
    autoCloseReason = 'hold_invalidated';
  } else if (
    holdStatus === 'expired' &&
    velocityScore < 30 &&
    (profitR ?? 0) < 0.5
  ) {
    // Time invalidation — past expected hold window, not converting.
    action = 'close';
    urgency = 'high';
    confidence = 78;
    reasons.push(
      `Time-invalidated: past expected hold window with velocity ${velocityScore}/100 and profitR ${(profitR ?? 0).toFixed(2)}.`,
    );
    autoCloseReason = 'time_invalidated';
  } else if (opportunityCostScore < opportunityCostExitThreshold && (profitR ?? 0) <= 0) {
    action = 'close';
    urgency = 'medium';
    confidence = 70;
    reasons.push(
      `Opportunity cost ${opportunityCostScore}/100 below threshold ${opportunityCostExitThreshold} and trade is not profitable — would not re-enter now.`,
    );
    autoCloseReason = 'opportunity_cost';
  } else if (momentumDecayScore >= 70 && (profitR ?? 0) >= 1) {
    action = 'partial_close';
    urgency = 'medium';
    confidence = 75;
    reasons.push(
      `Momentum decaying (decay ${momentumDecayScore}/100) with ${(profitR ?? 0).toFixed(2)}R locked — take partial.`,
    );
  } else if (
    velocityScore >= 75 &&
    momentumStatus !== 'decaying' &&
    tpProgress >= 0.5
  ) {
    action = 'expand_tp';
    urgency = 'low';
    confidence = 72;
    suggestedNewTP = Math.max(dynamicTP.currentRecommendedTargetPips, dynamicTP.maxTargetPips);
    reasons.push(
      `Velocity ${velocityScore}/100 with ${momentumStatus} momentum — extend TP to capture trend.`,
    );
  } else if (velocityScore < 30 && (profitR ?? 0) >= 0.5) {
    action = 'tighten_sl';
    urgency = 'medium';
    confidence = 68;
    // Tighten SL to ~1 ATR behind current price in the trade's favour direction.
    if (Number.isFinite(atrPipsCurrent) && pipSize > 0) {
      const buffer = atrPipsCurrent * 1.5 * pipSize;
      const baseRef = entryPrice + (side === 'long' ? buffer : -buffer);
      suggestedNewSL = +baseRef.toFixed(5);
    }
    reasons.push(
      `Velocity ${velocityScore}/100 with ${(profitR ?? 0).toFixed(2)}R in pocket — tighten SL to protect gains.`,
    );
  } else if (velocityScore < 30 && momentumDecayScore >= 50) {
    action = 'reduce_tp';
    urgency = 'medium';
    confidence = 65;
    suggestedNewTP = Math.min(dynamicTP.currentRecommendedTargetPips, dynamicTP.minTargetPips);
    reasons.push(
      `Velocity ${velocityScore}/100, momentum decaying — reduce TP toward realistic exit.`,
    );
  } else {
    action = 'hold';
    urgency = 'low';
    confidence = 60;
    reasons.push(
      `Velocity ${velocityScore}/100, momentum ${momentumStatus}, hold ${holdStatus} — no management action required.`,
    );
  }

  // Auto-close gate: only true when the platform flag is on AND the action
  // is `close` AND urgency is high. Anything else is recommendation-only.
  if (liveAutoCloseEnabled && action === 'close' && urgency === 'high') {
    shouldAutoClose = true;
  } else {
    autoCloseReason = null;
  }

  return {
    action,
    reason: reasons.join(' '),
    urgency,
    confidence,
    suggestedNewSL,
    suggestedNewTP,
    shouldAutoClose,
    autoCloseReason,
  };
}

// ─── Signal Stack V3 — Expected-R / Pro Exit Framework helpers ──────────────

/**
 * Break-even recommendation. Default trigger: profitR >= 0.8 AND momentum
 * status is stable or improving (i.e. not decaying).
 */
export function computeBreakeven({
  profitR,
  momentumStatus,
  side,
  entryPrice,
  currentSL,
  pipSize,
}) {
  const r = finite(profitR, 0);
  if (r < 0.8 || momentumStatus === 'decaying') {
    return {
      eligible: false,
      recommendedSL: currentSL ?? null,
      reason:
        r < 0.8
          ? `Profit ${r.toFixed(2)}R below 0.8R break-even threshold.`
          : `Momentum is ${momentumStatus} — wait for stable/improving before break-even.`,
    };
  }
  // Already past break-even on the existing SL? Skip recommendation.
  const safeBuffer = pipSize > 0 ? pipSize : 0.0001;
  const alreadyAtBreakeven =
    currentSL != null &&
    ((side === 'long' && currentSL >= entryPrice - safeBuffer) ||
      (side === 'short' && currentSL <= entryPrice + safeBuffer));
  if (alreadyAtBreakeven) {
    return {
      eligible: false,
      recommendedSL: currentSL,
      reason: 'SL already at or past break-even — no further adjustment needed.',
    };
  }
  return {
    eligible: true,
    recommendedSL: +entryPrice.toFixed(5),
    reason: `Profit ${r.toFixed(2)}R with ${momentumStatus} momentum — move SL to break-even.`,
  };
}

/**
 * Multi-target framework: TP1=1R, TP2=2R, TP3=3R.
 */
export function computeMultiTargets({
  riskPips,
  side,
  entryPrice,
  pipSize,
  profitPipsNow,
}) {
  const risk = Math.max(1, finite(riskPips, 20));
  const stages = [1, 2, 3].map((multiple, idx) => {
    const pips = risk * multiple;
    const offset = pips * pipSize;
    return {
      stage: `TP${idx + 1}`,
      multiple,
      pips: Math.round(pips),
      price: +(side === 'long' ? entryPrice + offset : entryPrice - offset).toFixed(5),
    };
  });
  const profit = finite(profitPipsNow, 0);
  const currentStage =
    profit >= stages[2].pips
      ? 'TP3+'
      : profit >= stages[1].pips
        ? 'TP2'
        : profit >= stages[0].pips
          ? 'TP1'
          : 'pre-TP1';
  return { stages, currentStage };
}

/**
 * Partial-close plan tied to the current stage and momentum status.
 * Defaults: TP1 → close 25%; TP2 → close 25% more; beyond TP3 if momentum
 * is decaying → close 50%.
 */
export function computePartialClosePlan({ currentStage, momentumStatus }) {
  if (currentStage === 'TP1') {
    return { recommendedPartialClosePercent: 25, reason: 'At TP1 — bank 25% to lock initial R.' };
  }
  if (currentStage === 'TP2') {
    return { recommendedPartialClosePercent: 25, reason: 'At TP2 — bank another 25%; leave 50% as runner.' };
  }
  if (currentStage === 'TP3+' && momentumStatus === 'decaying') {
    return {
      recommendedPartialClosePercent: 50,
      reason: 'Beyond TP3 with decaying momentum — close 50%, ride remainder on lifecycle.',
    };
  }
  return { recommendedPartialClosePercent: 0, reason: 'No partial close indicated at current stage.' };
}

/**
 * Dynamic trailing stop. Trail distance = ATR × multiplier. Multiplier
 * widens in expanding volatility, tightens in contracting volatility.
 * Trail is only recommended once profit ≥ 0.8R.
 */
export function computeDynamicTrail({
  atrPipsCurrent,
  atrPipsAtEntry,
  side,
  currentPrice,
  pipSize,
  profitR,
}) {
  const r = finite(profitR, 0);
  if (r < 0.8) {
    return { recommended: false, distancePips: null, price: null, multiplier: null };
  }
  const atrNow = Math.max(1, finite(atrPipsCurrent, 10));
  const atrEntry = finite(atrPipsAtEntry, atrNow);
  const ratio = atrEntry > 0 ? atrNow / atrEntry : 1;
  let multiplier = 1.5;
  if (ratio > 1.2) multiplier = 2.0;        // expanding volatility — widen
  else if (ratio < 0.8) multiplier = 1.0;   // contracting — tighten
  const distancePips = Math.round(atrNow * multiplier);
  const offset = distancePips * pipSize;
  const price = +(side === 'long' ? currentPrice - offset : currentPrice + offset).toFixed(5);
  return { recommended: true, distancePips, price, multiplier };
}

/**
 * Trend-exhaustion detector. Combines:
 *   - ATR climax (atr now >> atr at entry)
 *   - Momentum divergence (decaying momentum while in profit)
 *   - Excessive run vs ATR (profit > 3.5 × ATR_at_entry)
 *   - Candle weakness with profitable trade
 */
export function computeTrendExhaustion({
  atrPipsCurrent,
  atrPipsAtEntry,
  profitR,
  profitPipsNow,
  momentumStatus,
  candleStrengthScore,
  velocityScore,
}) {
  let score = 0;
  const atrEntry = finite(atrPipsAtEntry, 0);
  const atrNow = finite(atrPipsCurrent, atrEntry);

  // ATR climax — current ATR vastly larger than entry-time ATR.
  if (atrEntry > 0 && atrNow > 2 * atrEntry) score += 35;
  else if (atrEntry > 0 && atrNow > 1.5 * atrEntry) score += 20;

  // Momentum divergence — price still in profit, but momentum signals decay.
  if (momentumStatus === 'decaying' && finite(profitR, 0) >= 1.0) score += 25;

  // Excessive run — profit dwarfs entry-time volatility (parabolic candidate).
  if (atrEntry > 0 && finite(profitPipsNow, 0) >= 3.5 * atrEntry) score += 20;

  // Candle weakness while in good profit — the last few candles can't sustain.
  if (finite(candleStrengthScore, 50) < 40 && finite(profitR, 0) >= 1.5) score += 10;

  // High velocity + decaying momentum = blow-off top fingerprint.
  if (finite(velocityScore, 0) >= 80 && momentumStatus === 'decaying') score += 10;

  score = clamp(round(score), 0, 100);
  const status = score < 30 ? 'normal' : score < 70 ? 'extended' : 'exhausted';
  return { trendExhaustionScore: score, trendExhaustionStatus: status };
}

/**
 * Capital-efficiency score — "is this trade tying up capital well?"
 * Higher = better use of capital. Label maps:
 *   ≥80 Excellent · ≥60 Good · ≥40 Average · ≥25 Poor · <25 Exit Candidate
 */
export function computeCapitalEfficiency({
  velocityScore,
  opportunityCostScore,
  holdRatio,
  marketStateAllowed,
  expectedRR,
}) {
  const v = finite(velocityScore, 50);
  const oc = finite(opportunityCostScore, 50);
  const ratio = finite(holdRatio, 0.5);
  const timeComponent = ratio < 1 ? 20 : ratio < 1.5 ? 10 : 0;
  const stateComponent = marketStateAllowed ? 10 : 0;
  const rr = finite(expectedRR, 0);
  const rrComponent = rr >= 2.25 ? 15 : rr >= 1.75 ? 10 : rr >= 1.0 ? 5 : 0;

  const raw = v * 0.30 + oc * 0.30 + timeComponent + stateComponent + rrComponent;
  const score = clamp(round(raw), 0, 100);
  const label =
    score >= 80 ? 'Excellent'
    : score >= 60 ? 'Good'
    : score >= 40 ? 'Average'
    : score >= 25 ? 'Poor'
    : 'Exit Candidate';
  return { capitalEfficiencyScore: score, capitalEfficiencyLabel: label };
}

/**
 * Unified recommendation cascade — folds the existing lifecycle recommendation
 * with break-even, trend exhaustion, and capital efficiency into ONE action
 * the user should take. Priority (highest first):
 *
 *   1. Invalidation
 *   2. Time Invalidation
 *   3. Trend Exhaustion
 *   4. Opportunity Cost (exit candidate)
 *   5. Momentum Decay
 *   6. Dynamic TP Expansion
 *   7. Break-Even Eligible
 *   8. Hold
 *
 * Conflict notes surface when a positive signal coexists with a higher-
 * priority exit signal (e.g. "Momentum recovering, but invalidation remains
 * active."). Returns a single action plus the conflict array.
 */
export function pickUnifiedRecommendation({
  baseRecommendation,
  trendExhaustion,
  capitalEfficiency,
  breakeven,
  momentumStatus,
  invalidationDetected,
  holdStatus,
  partialClosePercent,
  multiTargets,
}) {
  const conflicts = [];
  let action = baseRecommendation.action;
  let reason = baseRecommendation.reason;
  let urgency = baseRecommendation.urgency;
  let confidence = baseRecommendation.confidence;
  let suggestedNewSL = baseRecommendation.suggestedNewSL;
  let suggestedNewTP = baseRecommendation.suggestedNewTP;
  let shouldAutoClose = baseRecommendation.shouldAutoClose;
  let autoCloseReason = baseRecommendation.autoCloseReason;
  let source = 'base_lifecycle';

  // 3. Trend exhaustion — only escalates if the base action is hold/expand.
  if (trendExhaustion.trendExhaustionStatus === 'exhausted' &&
      !['close', 'partial_close'].includes(action)) {
    action = 'partial_close';
    urgency = 'medium';
    confidence = Math.max(confidence, 72);
    reason = `Trend exhausted (${trendExhaustion.trendExhaustionScore}/100) — bank profit while available. ${reason}`;
    source = 'trend_exhaustion';
  }

  // 4. Capital efficiency: 'Exit Candidate' nudges toward close if not already.
  if (capitalEfficiency.capitalEfficiencyLabel === 'Exit Candidate' &&
      !['close', 'partial_close'].includes(action)) {
    conflicts.push(
      `Capital efficiency labelled Exit Candidate (${capitalEfficiency.capitalEfficiencyScore}/100) — this position is poor capital use.`,
    );
  }

  // 7. Break-even — only when no exit signal is active and base action is hold.
  if (breakeven.eligible && action === 'hold') {
    action = 'tighten_sl';
    suggestedNewSL = breakeven.recommendedSL;
    urgency = 'low';
    confidence = Math.max(confidence, 68);
    reason = `${breakeven.reason}`;
    source = 'breakeven';
  }

  // Conflict surfacing: improving momentum vs active exit signal.
  if (
    momentumStatus === 'improving' &&
    (invalidationDetected || holdStatus === 'expired' || trendExhaustion.trendExhaustionStatus === 'exhausted')
  ) {
    conflicts.push(
      'Momentum is recovering, but exit signal remains active — exit signal takes priority.',
    );
  }

  // Multi-target context inside the reason when a partial-close % is staged.
  let unifiedSummary = reason;
  if (partialClosePercent > 0 && action === 'partial_close') {
    unifiedSummary += ` Recommended partial close: ${partialClosePercent}%.`;
  }
  if (multiTargets?.currentStage && multiTargets.currentStage !== 'pre-TP1') {
    unifiedSummary += ` Current target stage: ${multiTargets.currentStage}.`;
  }
  if (conflicts.length > 0) {
    unifiedSummary += ` However: ${conflicts.join(' ')}`;
  }

  return {
    action,
    reason,
    urgency,
    confidence,
    suggestedNewSL,
    suggestedNewTP,
    shouldAutoClose,
    autoCloseReason,
    source,
    conflictNotes: conflicts,
    unifiedSummary,
  };
}

/**
 * Main entry — accepts the full trade context the reassessor already has
 * and emits the full lifecycle view.
 */
export function analyzeTradeLifecycle(ctx) {
  const {
    pair,
    tradeId,
    side,
    entryPrice,
    currentPrice,
    currentSL,
    originalTpPips,
    minutesElapsed,
    expectedHoldTimeMinutes,
    profitR,
    profitPipsNow,
    tpProgress,
    pipSize,
    entryAlignmentScore,
    currentAlignmentScore,
    entryMtfScore,
    currentMtfScore,
    candleStrengthScore,
    atrPipsAtEntry,
    atrPipsCurrent,
    mtfConflict,
    flowOpposes,
    flowMatchesDirection,
    m15TrendReversed,
    volatilityCollapsed,
    invalidationDetected,
    invalidationReason,
    currentConfidence,
    spreadPips,
    maxSpreadPips,
    marketStateAllowed,
    liveAutoCloseEnabled,
    opportunityCostExitThreshold,
  } = ctx;

  const velocityScore = computeVelocityScore({
    minutesElapsed,
    expectedHoldTimeMinutes,
    tpProgress,
    profitR,
  });

  const { momentumDecayScore, momentumStatus } = computeMomentumDecay({
    entryAlignmentScore,
    currentAlignmentScore,
    entryMtfScore,
    currentMtfScore,
    candleStrengthScore,
    atrPipsAtEntry,
    atrPipsCurrent,
    mtfConflict,
    flowOpposes,
    m15TrendReversed,
  });

  const hold = computeHoldStatus({
    minutesElapsed,
    expectedHoldTimeMinutes,
    velocityScore,
    invalidationDetected,
  });

  const dynamicTP = computeDynamicTP({
    originalTpPips,
    velocityScore,
    momentumDecayScore,
    atrPipsAtEntry,
    atrPipsCurrent,
    profitPipsNow,
    volatilityCollapsed,
  });

  const opportunityCostScore = computeOpportunityCost({
    currentAlignmentScore,
    currentConfidence,
    currentMtfScore,
    candleStrengthScore,
    marketStateAllowed,
    spreadPips,
    maxSpreadPips,
    flowMatchesDirection,
    tpProgress,
  });

  const recommendation = pickRecommendation({
    velocityScore,
    momentumDecayScore,
    momentumStatus,
    holdStatus: hold.holdStatus,
    opportunityCostScore,
    dynamicTP,
    profitR,
    tpProgress,
    pipSize,
    side,
    entryPrice,
    currentSL,
    atrPipsCurrent,
    invalidationDetected,
    invalidationReason,
    liveAutoCloseEnabled,
    opportunityCostExitThreshold,
  });

  // ── Signal Stack V3 — Expected R / pro exit framework ───────────────────
  const breakeven = computeBreakeven({
    profitR,
    momentumStatus,
    side,
    entryPrice,
    currentSL,
    pipSize,
  });
  // SL-distance in pips, used by multi-target framework. Prefer original
  // SL distance if available; otherwise derive from currentSL.
  const slPips =
    ctx.originalSlPips != null && Number.isFinite(ctx.originalSlPips)
      ? Math.max(1, ctx.originalSlPips)
      : currentSL != null && pipSize > 0
        ? Math.max(1, Math.abs(entryPrice - currentSL) / pipSize)
        : 20;
  const multiTargets = computeMultiTargets({
    riskPips: slPips,
    side,
    entryPrice,
    pipSize,
    profitPipsNow,
  });
  const partialClose = computePartialClosePlan({
    currentStage: multiTargets.currentStage,
    momentumStatus,
  });
  const dynamicTrail = computeDynamicTrail({
    atrPipsCurrent,
    atrPipsAtEntry: ctx.atrPipsAtEntry,
    side,
    currentPrice: ctx.currentPrice,
    pipSize,
    profitR,
  });
  const trendExhaustion = computeTrendExhaustion({
    atrPipsCurrent,
    atrPipsAtEntry: ctx.atrPipsAtEntry,
    profitR,
    profitPipsNow,
    momentumStatus,
    candleStrengthScore: ctx.candleStrengthScore,
    velocityScore,
  });
  const capitalEfficiency = computeCapitalEfficiency({
    velocityScore,
    opportunityCostScore,
    holdRatio: hold.holdRatio,
    marketStateAllowed: ctx.marketStateAllowed,
    expectedRR: ctx.expectedRR,
  });
  const unified = pickUnifiedRecommendation({
    baseRecommendation: recommendation,
    trendExhaustion,
    capitalEfficiency,
    breakeven,
    momentumStatus,
    invalidationDetected,
    holdStatus: hold.holdStatus,
    partialClosePercent: partialClose.recommendedPartialClosePercent,
    multiTargets,
  });

  const logLine =
    `[TRADE_LIFECYCLE] pair=${pair} tradeId=${tradeId ?? '?'} ` +
    `velocity=${velocityScore} momentum=${momentumStatus}(${momentumDecayScore}) ` +
    `holdStatus=${hold.holdStatus} ` +
    `tp=${dynamicTP.currentRecommendedTargetPips}p(${dynamicTP.minTargetPips}-${dynamicTP.maxTargetPips}) ` +
    `opportunity=${opportunityCostScore} ` +
    `targetStage=${multiTargets.currentStage} ` +
    `trendExhaustion=${trendExhaustion.trendExhaustionStatus}(${trendExhaustion.trendExhaustionScore}) ` +
    `capEff=${capitalEfficiency.capitalEfficiencyLabel}(${capitalEfficiency.capitalEfficiencyScore}) ` +
    `action=${unified.action} urgency=${unified.urgency}` +
    (unified.shouldAutoClose ? ` autoClose=${unified.autoCloseReason}` : '') +
    (unified.conflictNotes.length ? ` conflicts=${unified.conflictNotes.length}` : '');

  return {
    velocityScore,
    momentumDecayScore,
    momentumStatus,
    holdStatus: hold.holdStatus,
    holdRatio: hold.holdRatio,
    expectedRemainingHoldTime: hold.expectedRemainingHoldTime,
    dynamicTP,
    opportunityCostScore,
    // Signal Stack V3 additions
    breakeven,
    multiTargets,
    partialClose,
    dynamicTrail,
    trendExhaustion,
    capitalEfficiency,
    recommendation: unified,
    baseRecommendation: recommendation,
    logLine,
  };
}
