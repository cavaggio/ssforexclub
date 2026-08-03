/**
 * Active Exit Intelligence v1.
 *
 * Pure, deterministic decision policy for an already-open trade. The original
 * take-profit remains the default objective. The policy intervenes only when
 * fresh market evidence shows material reversal/giveback risk or when a
 * profitable breakout should be partially protected.
 *
 * Actions:
 *   HOLD_TO_TP     — preserve the original target and position size.
 *   PARTIAL_CLOSE  — close a bounded percentage once; keep a runner for TP.
 *   FULL_CLOSE     — exit on hard invalidation, loss rescue, or confirmed
 *                    momentum-peak/giveback conditions.
 */

export const ACTIVE_EXIT_POLICY = 'active_exit_intelligence_v1';

const finite = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const text = (value) => String(value ?? '').toLowerCase();

function reversalRiskOf(plan) {
  return text(
    plan?.reversalRisk ??
    plan?.detail?.invalidation?.reversalRisk ??
    plan?.detail?.trendWeakening?.severity ??
    plan?.trendWeakeningSeverity,
  );
}

function lifecycleActionOf(plan) {
  return text(
    plan?.ictLifecycle?.action ??
    plan?.lifecycleRecommendation?.action ??
    plan?.recommendedAction,
  );
}

function breakoutConfirmed(plan) {
  const marketState = text(plan?.marketState ?? plan?.detail?.marketState?.marketState);
  const signals = Array.isArray(plan?.institutionalFlow?.signals)
    ? plan.institutionalFlow.signals
    : Array.isArray(plan?.detail?.institutionalFlow?.signals)
      ? plan.detail.institutionalFlow.signals
      : [];
  const directionalRetest = signals.some((signal) => {
    const type = text(signal?.type);
    const direction = text(signal?.direction);
    const side = text(plan?.direction ?? plan?.side);
    return type.includes('retest') && (
      !direction ||
      (side === 'long' && direction === 'bullish') ||
      (side === 'short' && direction === 'bearish')
    );
  });
  return marketState.includes('breakout') || directionalRetest;
}

function opposingStructure(plan) {
  const action = lifecycleActionOf(plan);
  const momentum = text(plan?.momentumStatus);
  return Boolean(
    action === 'close' || action === 'exit' || action === 'exit_now' || action === 'exit_invalidated' ||
    plan?.institutionalFlow?.opposes === true ||
    plan?.detail?.institutionalFlow?.opposes === true ||
    plan?.m15TrendReversed === true ||
    momentum.includes('reversal') || momentum.includes('reversed')
  );
}

function actionResult({
  action,
  percent = 0,
  reason,
  confidence,
  evidence,
  metrics,
}) {
  return {
    action,
    closePercent: percent,
    reason,
    confidence: Math.round(clamp(confidence, 0, 100)),
    policy: ACTIVE_EXIT_POLICY,
    preserveOriginalTakeProfit: action !== 'FULL_CLOSE',
    evidence,
    metrics,
  };
}

/**
 * @param {Record<string, any>} plan active-trade reassessment payload
 * @param {{
 *   priorPartialCount?: number,
 *   peakProfitR?: number|null,
 *   peakProfitPips?: number|null,
 * }} state persisted management state for this broker trade
 */
export function evaluateActiveExit(plan = {}, state = {}) {
  const profitR = finite(plan.profitRMultiple ?? plan.profitR, 0);
  const initialRiskPips = Math.abs(finite(
    plan.initialRiskPips ?? plan.originalRiskPips ?? plan.detail?.lifecycle?.originalSlPips,
    0,
  ));
  const currentProfitPips = initialRiskPips > 0
    ? profitR * initialRiskPips
    : finite(plan.unrealizedPips, 0);
  const tpProgressRaw = finite(plan.tpProgress ?? plan.partialClose?.tpProgress, 0);
  const tpProgress = tpProgressRaw > 1 ? tpProgressRaw / 100 : tpProgressRaw;
  const momentumDecayScore = finite(plan.momentumDecayScore, 0);
  const momentumStatus = text(plan.momentumStatus);
  const reversalRisk = reversalRiskOf(plan);
  const priorPartialCount = Math.max(0, Math.floor(finite(state.priorPartialCount, 0)));

  const persistedPeakR = finite(state.peakProfitR, profitR);
  const persistedPeakPips = finite(state.peakProfitPips, currentProfitPips);
  const peakProfitR = Math.max(profitR, persistedPeakR ?? profitR);
  const peakProfitPips = Math.max(currentProfitPips, persistedPeakPips ?? currentProfitPips);
  const calculatedGiveback = peakProfitPips > 0
    ? clamp(((peakProfitPips - currentProfitPips) / peakProfitPips) * 100, 0, 100)
    : 0;
  const givebackPercent = Math.max(
    calculatedGiveback,
    clamp(finite(plan.givebackPercent, 0), 0, 100),
  );

  const lifecycleAction = lifecycleActionOf(plan);
  const hardInvalidation = Boolean(
    plan.invalidationDetected === true ||
    text(plan.invalidationSeverity) === 'high' ||
    lifecycleAction === 'close' || lifecycleAction === 'exit' ||
    lifecycleAction === 'exit_now' || lifecycleAction === 'exit_invalidated'
  );
  const structureOpposes = opposingStructure(plan);
  const reversalHigh = reversalRisk === 'high' || hardInvalidation || (
    structureOpposes && (
      plan.trendWeakeningDetected === true ||
      momentumDecayScore >= 65 ||
      momentumStatus.includes('decay')
    )
  );
  const reversalMedium = reversalHigh || reversalRisk === 'medium' ||
    plan.trendWeakeningDetected === true || momentumDecayScore >= 50 ||
    momentumStatus.includes('slowing') || momentumStatus.includes('decay');
  const breakout = breakoutConfirmed(plan);
  const nearStop = finite(plan.distanceToSL, Infinity) <= Math.max(2, initialRiskPips * 0.25);
  const lossRescueZone = currentProfitPips >= -2 && currentProfitPips <= Math.max(1, initialRiskPips * 0.15);

  const metrics = {
    profitR: +profitR.toFixed(3),
    currentProfitPips: +currentProfitPips.toFixed(2),
    peakProfitR: +peakProfitR.toFixed(3),
    peakProfitPips: +peakProfitPips.toFixed(2),
    givebackPercent: +givebackPercent.toFixed(1),
    tpProgress: +tpProgress.toFixed(3),
    momentumDecayScore,
    reversalRisk: reversalRisk || null,
    priorPartialCount,
    breakoutConfirmed: breakout,
    nearStop,
  };

  if (hardInvalidation) {
    return actionResult({
      action: 'FULL_CLOSE',
      percent: 100,
      reason: 'The live market invalidated the original trade thesis; exit instead of waiting for the protective stop.',
      confidence: 94,
      evidence: ['hard_invalidation', lifecycleAction || 'invalidation_detected'],
      metrics,
    });
  }

  if (reversalHigh && (lossRescueZone || nearStop || profitR < 0)) {
    return actionResult({
      action: 'FULL_CLOSE',
      percent: 100,
      reason: lossRescueZone
        ? 'Reversal risk is high while the trade is near breakeven; close in the minimal-loss rescue zone before a full stop loss.'
        : 'Reversal risk is high and the trade is deteriorating toward its stop; close to reduce the avoidable loss.',
      confidence: lossRescueZone ? 88 : 86,
      evidence: ['high_reversal_risk', lossRescueZone ? 'minimal_loss_rescue' : 'stop_risk'],
      metrics,
    });
  }

  const confirmedMomentumPeak = profitR >= 0.5 && (
    (reversalHigh && givebackPercent >= 12) ||
    (momentumDecayScore >= 75 && givebackPercent >= 20) ||
    (givebackPercent >= 35 && reversalMedium)
  );
  if (confirmedMomentumPeak) {
    return actionResult({
      action: 'FULL_CLOSE',
      percent: 100,
      reason: 'Favorable momentum has peaked and reversal/giveback risk is now high; realize the remaining profit rather than returning it to the market.',
      confidence: reversalHigh ? 89 : 82,
      evidence: ['momentum_peak', 'profit_giveback', reversalHigh ? 'high_reversal_risk' : 'momentum_decay'],
      metrics,
    });
  }

  const strongBreakoutContinuation = breakout && profitR > 0 &&
    momentumDecayScore < 45 && !reversalMedium && givebackPercent < 12;
  if (strongBreakoutContinuation) {
    return actionResult({
      action: 'HOLD_TO_TP',
      reason: 'Breakout continuation remains strong with limited giveback; preserve the full position for the original take profit.',
      confidence: 84,
      evidence: ['breakout_continuation', 'momentum_intact', 'original_tp_priority'],
      metrics,
    });
  }

  const existingPartial = Boolean(
    plan.partialExitRecommended === true ||
    plan.partialClose?.recommendedPartialClosePercent > 0 ||
    finite(plan.partialExitPercent, 0) > 0 ||
    lifecycleAction === 'partial_close' || lifecycleAction === 'partial_exit'
  );
  const breakoutProtection = breakout && profitR >= 0.8 && (
    reversalMedium || momentumDecayScore >= 45 || givebackPercent >= 12
  );
  const nearTargetProtection = tpProgress >= 0.7 && profitR > 0 && (
    reversalMedium || momentumDecayScore >= 45 || givebackPercent >= 10
  );
  const profitableWeakening = profitR >= 1 && (
    existingPartial || reversalMedium || momentumDecayScore >= 55 || givebackPercent >= 15
  );

  if (priorPartialCount < 1 && (breakoutProtection || nearTargetProtection || profitableWeakening)) {
    const recommended = finite(
      plan.partialExitPercent ?? plan.partialClose?.recommendedPartialClosePercent,
      0,
    );
    const percent = clamp(
      recommended > 0 ? Math.round(recommended) : reversalHigh ? 50 : profitR >= 1.5 ? 33 : 25,
      25,
      50,
    );
    return actionResult({
      action: 'PARTIAL_CLOSE',
      percent,
      reason: breakoutProtection
        ? `The breakout is profitable but continuation quality is weakening; close ${percent}% to lock profit and keep the remainder for TP.`
        : nearTargetProtection
          ? `The trade is near its target while momentum/reversal risk is increasing; close ${percent}% and keep a TP runner.`
          : `The position is at least +1R and live momentum is weakening; close ${percent}% to protect the gain while preserving upside.`,
      confidence: reversalMedium ? 80 : 74,
      evidence: [
        breakoutProtection ? 'breakout_profit_protection' : nearTargetProtection ? 'near_target_protection' : 'profitable_weakening',
        'single_partial_limit',
        'runner_preserved',
      ],
      metrics,
    });
  }

  return actionResult({
    action: 'HOLD_TO_TP',
    reason: priorPartialCount >= 1 && reversalMedium
      ? 'A partial profit has already been taken; the remaining runner stays on the original TP until a full-close condition is confirmed.'
      : 'The original thesis remains valid and exit risk is not strong enough to override the take-profit objective.',
    confidence: reversalMedium ? 62 : 76,
    evidence: ['original_tp_priority', priorPartialCount >= 1 ? 'partial_already_taken' : 'no_exit_trigger'],
    metrics,
  });
}

export function closeUnitsForDecision(currentUnits, decision) {
  const units = Math.floor(Math.abs(finite(currentUnits, 0)));
  if (decision?.action === 'FULL_CLOSE') return 'ALL';
  if (decision?.action !== 'PARTIAL_CLOSE' || units <= 1) return null;
  const requested = Math.floor(units * clamp(finite(decision.closePercent, 0), 1, 99) / 100);
  return Math.max(1, Math.min(units - 1, requested));
}
