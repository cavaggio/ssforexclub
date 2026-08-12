/**
 * Profit Protection v2.
 *
 * Automated management is deliberately unable to liquidate a full trade.
 * The broker stop remains the sole loss authority. Management can only:
 *   - move the stop to breakeven after sufficient favorable movement;
 *   - bank one partial while momentum is still favorable;
 *   - remove the runner's fixed TP after that partial; and
 *   - trail the runner only after price reaches the original TP threshold.
 */

export const ACTIVE_EXIT_POLICY = 'profit_protection_v2';

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
  const side = text(plan?.direction ?? plan?.side);
  const directionalRetest = signals.some((signal) => {
    const type = text(signal?.type);
    const direction = text(signal?.direction);
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
    action === 'close' || action === 'exit' || action === 'exit_now' ||
    action === 'exit_invalidated' ||
    plan?.institutionalFlow?.opposes === true ||
    plan?.detail?.institutionalFlow?.opposes === true ||
    plan?.m15TrendReversed === true ||
    momentum.includes('reversal') || momentum.includes('reversed')
  );
}

function trailingStopFor(plan, direction, entryPrice, currentPrice) {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(currentPrice)) return null;

  const structureStop = finite(plan?.recommendedStopLoss, null);
  const favorableMove = direction === 'short'
    ? entryPrice - currentPrice
    : currentPrice - entryPrice;
  if (!(favorableMove > 0)) return entryPrice;

  // Lock 60% of the move beyond the original target when no stronger valid
  // structure stop is available. The broker updater still enforces price
  // buffer, breakeven, and never-move-backward rules.
  const fallback = direction === 'short'
    ? entryPrice - favorableMove * 0.6
    : entryPrice + favorableMove * 0.6;
  if (!Number.isFinite(structureStop)) return fallback;
  return direction === 'short'
    ? Math.min(fallback, structureStop)
    : Math.max(fallback, structureStop);
}

function actionResult({
  action,
  percent = 0,
  reason,
  confidence,
  evidence,
  metrics,
  stopLoss = null,
  cancelTakeProfit = false,
}) {
  return {
    action,
    closePercent: percent,
    reason,
    confidence: Math.round(clamp(confidence, 0, 100)),
    policy: ACTIVE_EXIT_POLICY,
    stopLoss: Number.isFinite(stopLoss) ? stopLoss : null,
    cancelTakeProfit,
    automaticFullCloseAllowed: false,
    preserveOriginalTakeProfit: !cancelTakeProfit,
    originalTakeProfitRole: cancelTakeProfit
      ? 'runner_trailing_activation_threshold'
      : 'broker_target',
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
 *   runnerArmed?: boolean,
 *   breakEvenSet?: boolean,
 * }} state persisted management state for this broker trade
 */
export function evaluateActiveExit(plan = {}, state = {}) {
  const direction = text(plan.direction ?? plan.side) === 'short' ? 'short' : 'long';
  const entryPrice = finite(plan.entryPrice, null);
  const currentPrice = finite(plan.currentPrice, null);
  const profitR = finite(plan.profitRMultiple ?? plan.profitR, 0);
  const initialRiskPips = Math.abs(finite(
    plan.initialRiskPips ?? plan.originalRiskPips ?? plan.detail?.lifecycle?.originalSlPips,
    0,
  ));
  const currentProfitPips = initialRiskPips > 0
    ? profitR * initialRiskPips
    : finite(plan.unrealizedPips, 0);
  const tpProgressRaw = finite(plan.tpProgress ?? plan.partialClose?.tpProgress, 0);
  const tpProgress = tpProgressRaw > 10 ? tpProgressRaw / 100 : tpProgressRaw;
  const momentumDecayScore = finite(plan.momentumDecayScore, 0);
  const momentumStatus = text(plan.momentumStatus);
  const reversalRisk = reversalRiskOf(plan);
  const priorPartialCount = Math.max(0, Math.floor(finite(state.priorPartialCount, 0)));
  const runnerArmed = state.runnerArmed === true;
  const breakEvenSet = state.breakEvenSet === true;

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
  const breakout = breakoutConfirmed(plan);
  const favorableMomentum = profitR > 0 && !reversalHigh && !structureOpposes && (
    breakout ||
    momentumDecayScore < 45 ||
    momentumStatus.includes('strong') ||
    momentumStatus.includes('accelerat') ||
    momentumStatus.includes('continu') ||
    momentumStatus.includes('stable')
  );
  const targetReached = Boolean(
    plan.originalTargetReached === true ||
    tpProgress >= 1
  );

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
    favorableMomentum,
    runnerArmed,
    breakEvenSet,
    targetReached,
    breakoutConfirmed: breakout,
  };

  if (priorPartialCount > 0 && !runnerArmed) {
    return actionResult({
      action: 'ARM_RUNNER',
      reason: 'A partial is already banked; move the remainder to breakeven and remove its fixed TP so it can trail only after the original target is reached.',
      confidence: 96,
      evidence: ['partial_already_taken', 'breakeven_runner', 'original_tp_becomes_threshold'],
      metrics,
      stopLoss: entryPrice,
      cancelTakeProfit: true,
    });
  }

  if (runnerArmed && targetReached) {
    return actionResult({
      action: 'TRAIL_PROFIT',
      reason: 'The runner reached the original TP threshold; trail the protective stop to secure additional profit without guessing a market exit.',
      confidence: 94,
      evidence: ['original_target_reached', 'post_tp_trailing', 'no_discretionary_close'],
      metrics,
      stopLoss: trailingStopFor(plan, direction, entryPrice, currentPrice),
      cancelTakeProfit: true,
    });
  }

  if (runnerArmed) {
    return actionResult({
      action: 'HOLD_TO_TP',
      reason: 'The partial is banked and the runner is protected at breakeven; wait for the original TP threshold before trailing profit.',
      confidence: 88,
      evidence: ['runner_armed', 'breakeven_protected', 'await_original_target'],
      metrics,
    });
  }

  if (priorPartialCount < 1 && favorableMomentum && (profitR >= 1 || (profitR >= 0.5 && tpProgress >= 0.65))) {
    const percent = profitR >= 1 ? 50 : 33;
    return actionResult({
      action: 'PARTIAL_CLOSE',
      percent,
      reason: `Momentum remains favorable; bank ${percent}% now, move the remainder to breakeven, and convert the original TP into the runner's trailing-activation threshold.`,
      confidence: breakout ? 90 : 84,
      evidence: ['favorable_momentum', 'single_partial_limit', 'breakeven_runner'],
      metrics,
      stopLoss: entryPrice,
      cancelTakeProfit: true,
    });
  }

  if (!breakEvenSet && profitR >= 1) {
    return actionResult({
      action: 'MOVE_STOP_TO_BREAKEVEN',
      reason: 'The position has reached +1R; remove the original capital risk by moving the stop to breakeven without closing the trade.',
      confidence: 92,
      evidence: ['one_r_reached', 'breakeven_protection', 'no_discretionary_close'],
      metrics,
      stopLoss: entryPrice,
    });
  }

  return actionResult({
    action: 'HOLD_TO_TP',
    reason: reversalHigh || structureOpposes
      ? 'Contrary evidence is recorded, but automatic early liquidation is disabled; the protective SL remains the loss authority.'
      : 'No profit-protection milestone is due; keep the original SL/TP and let the trade thesis resolve.',
    confidence: reversalHigh || structureOpposes ? 95 : 78,
    evidence: [
      'protective_sl_is_loss_authority',
      reversalHigh || structureOpposes ? 'no_discretionary_early_close' : 'await_profit_milestone',
    ],
    metrics,
  });
}

export function closeUnitsForDecision(currentUnits, decision) {
  const units = Math.floor(Math.abs(finite(currentUnits, 0)));
  if (decision?.action !== 'PARTIAL_CLOSE' || units <= 1) return null;
  const requested = Math.floor(units * clamp(finite(decision.closePercent, 0), 1, 99) / 100);
  return Math.max(1, Math.min(units - 1, requested));
}
