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

  const logLine =
    `[TRADE_LIFECYCLE] pair=${pair} tradeId=${tradeId ?? '?'} ` +
    `velocity=${velocityScore} momentum=${momentumStatus}(${momentumDecayScore}) ` +
    `holdStatus=${hold.holdStatus} ` +
    `tp=${dynamicTP.currentRecommendedTargetPips}p(${dynamicTP.minTargetPips}-${dynamicTP.maxTargetPips}) ` +
    `opportunity=${opportunityCostScore} ` +
    `action=${recommendation.action} urgency=${recommendation.urgency}` +
    (recommendation.shouldAutoClose ? ` autoClose=${recommendation.autoCloseReason}` : '');

  return {
    velocityScore,
    momentumDecayScore,
    momentumStatus,
    holdStatus: hold.holdStatus,
    holdRatio: hold.holdRatio,
    expectedRemainingHoldTime: hold.expectedRemainingHoldTime,
    dynamicTP,
    opportunityCostScore,
    recommendation,
    logLine,
  };
}
