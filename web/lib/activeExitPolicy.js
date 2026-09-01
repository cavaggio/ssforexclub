/**
 * Profit Protection v3 — fixed 10p SL / 15p TP / 18p final exit.
 *
 * Automated management is deliberately unable to liquidate a full trade before
 * the defined profit milestones. The broker stop remains the loss authority.
 * Policy: close 80% at +15 pips, move the remaining 20% to breakeven, then
 * close that final 20% at +18 pips. No discretionary early liquidation.
 */

export const ACTIVE_EXIT_POLICY = 'profit_protection_v3';
export const FIXED_STOP_LOSS_PIPS = 10;
export const FIRST_TAKE_PROFIT_PIPS = 15;
export const FIRST_PARTIAL_PERCENT = 80;
export const FINAL_TAKE_PROFIT_PIPS = 18;
export const FINAL_PARTIAL_PERCENT = 20;
export const FIXED_RR = 1.5;

const finite = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const text = (value) => String(value ?? '').toLowerCase();

function actionResult({ action, percent = 0, reason, confidence, evidence, metrics, stopLoss = null, cancelTakeProfit = false }) {
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
    originalTakeProfitRole: cancelTakeProfit ? 'fixed_profit_milestone' : 'broker_target',
    evidence,
    metrics,
  };
}

/**
 * Fixed exit policy:
 *   +15 pips -> close 80%, move remaining 20% SL to entry/breakeven.
 *   +18 pips -> close the remaining 20%.
 *
 * The second milestone is deliberately an explicit 20% close, not a runner
 * trail. This implements the requested C model exactly.
 */
export function evaluateActiveExit(plan = {}, state = {}) {
  const direction = text(plan.direction ?? plan.side) === 'short' ? 'short' : 'long';
  const entryPrice = finite(plan.entryPrice, null);
  const currentPrice = finite(plan.currentPrice, null);
  const currentProfitPips = finite(
    plan.unrealizedPips ?? plan.currentProfitPips,
    finite(plan.profitPips, 0),
  );
  const priorPartialCount = Math.max(0, Math.floor(finite(state.priorPartialCount, 0)));
  const firstPartialTaken = state.firstPartialTaken === true || priorPartialCount >= 1;
  const finalPartialTaken = state.finalPartialTaken === true || priorPartialCount >= 2;
  const breakEvenSet = state.breakEvenSet === true;

  const metrics = {
    currentProfitPips: +currentProfitPips.toFixed(2),
    fixedStopLossPips: FIXED_STOP_LOSS_PIPS,
    firstTakeProfitPips: FIRST_TAKE_PROFIT_PIPS,
    firstPartialPercent: FIRST_PARTIAL_PERCENT,
    finalTakeProfitPips: FINAL_TAKE_PROFIT_PIPS,
    finalPartialPercent: FINAL_PARTIAL_PERCENT,
    fixedRR: FIXED_RR,
    priorPartialCount,
    firstPartialTaken,
    finalPartialTaken,
    breakEvenSet,
  };

  // At +18 pips, close the remaining 20%. This is checked first so a price
  // jump from below +15 directly through +18 cannot strand the final runner.
  if (firstPartialTaken && !finalPartialTaken && currentProfitPips >= FINAL_TAKE_PROFIT_PIPS) {
    return actionResult({
      action: 'PARTIAL_CLOSE',
      percent: FINAL_PARTIAL_PERCENT,
      reason: `Final profit milestone reached at +${currentProfitPips.toFixed(1)} pips; close the remaining 20% at +${FINAL_TAKE_PROFIT_PIPS} pips.`,
      confidence: 98,
      evidence: ['eighteen_pip_final_milestone', 'remaining_twenty_percent', 'no_trailing_runner'],
      metrics,
      stopLoss: entryPrice,
      cancelTakeProfit: true,
    });
  }

  // First milestone: bank exactly 80%, then protect the remaining 20% at entry.
  if (!firstPartialTaken && currentProfitPips >= FIRST_TAKE_PROFIT_PIPS) {
    return actionResult({
      action: 'PARTIAL_CLOSE',
      percent: FIRST_PARTIAL_PERCENT,
      reason: `First profit milestone reached at +${currentProfitPips.toFixed(1)} pips; close 80% and move the remaining 20% stop to breakeven.`,
      confidence: 98,
      evidence: ['fifteen_pip_profit_milestone', 'eighty_percent_partial', 'breakeven_remaining_twenty'],
      metrics,
      stopLoss: entryPrice,
      cancelTakeProfit: true,
    });
  }

  // If the partial was already executed by another protection path, enforce
  // the requested breakeven protection independently on the next reconciliation.
  if (firstPartialTaken && !breakEvenSet) {
    return actionResult({
      action: 'MOVE_STOP_TO_BREAKEVEN',
      reason: 'The 80% first partial is already banked; move the remaining 20% stop to entry/breakeven and protect the runner until +18 pips.',
      confidence: 98,
      evidence: ['partial_already_taken', 'breakeven_required', 'remaining_twenty_percent'],
      metrics,
      stopLoss: entryPrice,
      cancelTakeProfit: true,
    });
  }

  if (firstPartialTaken && !finalPartialTaken) {
    return actionResult({
      action: 'HOLD_TO_TP',
      reason: `80% is banked and the remaining 20% is protected at breakeven; hold for the fixed +${FINAL_TAKE_PROFIT_PIPS} pip final milestone.`,
      confidence: 94,
      evidence: ['eighty_percent_banked', 'breakeven_protected', 'await_eighteen_pips'],
      metrics,
      cancelTakeProfit: true,
    });
  }

  return actionResult({
    action: 'HOLD_TO_TP',
    reason: `No profit milestone is due; broker SL remains the loss authority and the fixed +${FIRST_TAKE_PROFIT_PIPS} pip first target remains active.`,
    confidence: 90,
    evidence: ['protective_sl_is_loss_authority', 'await_fifteen_pips'],
    metrics,
  });
}

export function closeUnitsForDecision(currentUnits, decision) {
  const units = Math.floor(Math.abs(finite(currentUnits, 0)));
  if (decision?.action !== 'PARTIAL_CLOSE' || units <= 1) return null;
  const requested = Math.floor(units * clamp(finite(decision.closePercent, 0), 1, 99) / 100);
  return Math.max(1, Math.min(units - 1, requested));
}
