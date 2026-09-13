/**
 * Profit Protection v4 — fixed 15p SL / +10p breakeven / 80%@+15p / 20%@+18p.
 *
 * Automated management never widens a stop or guesses an early exit. The broker
 * stop remains the loss authority until price reaches +10 pips, at which point
 * the stop moves to entry. At +15 pips the system banks 80%; the remaining 20%
 * stays protected at breakeven and exits at +18 pips.
 */

export const ACTIVE_EXIT_POLICY = 'profit_protection_v4';
export const FIXED_STOP_LOSS_PIPS = 15;
export const BREAK_EVEN_TRIGGER_PIPS = 10;
export const FIRST_TAKE_PROFIT_PIPS = 15;
export const FIRST_PARTIAL_PERCENT = 80;
export const FINAL_TAKE_PROFIT_PIPS = 18;
export const FINAL_PARTIAL_PERCENT = 20;
// Blended reward/risk if both milestones fill: 0.8*(15/15) + 0.2*(18/15) = 1.04R.
export const FIXED_RR = 1.04;
export const FINAL_TARGET_RR = 1.2;

const finite = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function actionResult({ action, percent = 0, reason, confidence, evidence, metrics, stopLoss = null }) {
  return {
    action,
    closePercent: percent,
    reason,
    confidence: Math.round(clamp(confidence, 0, 100)),
    policy: ACTIVE_EXIT_POLICY,
    stopLoss: Number.isFinite(stopLoss) ? stopLoss : null,
    cancelTakeProfit: false,
    automaticFullCloseAllowed: false,
    preserveOriginalTakeProfit: true,
    originalTakeProfitRole: 'broker_target',
    evidence,
    metrics,
  };
}

/**
 * Fixed exit policy:
 *   +10 pips -> move SL to entry/breakeven.
 *   +15 pips -> close 80%; keep the remaining 20% protected at breakeven.
 *   +18 pips -> close the remaining 20%.
 */
export function evaluateActiveExit(plan = {}, state = {}) {
  const entryPrice = finite(plan.entryPrice, null);
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
    breakEvenTriggerPips: BREAK_EVEN_TRIGGER_PIPS,
    firstTakeProfitPips: FIRST_TAKE_PROFIT_PIPS,
    firstPartialPercent: FIRST_PARTIAL_PERCENT,
    finalTakeProfitPips: FINAL_TAKE_PROFIT_PIPS,
    finalPartialPercent: FINAL_PARTIAL_PERCENT,
    fixedRR: FIXED_RR,
    finalTargetRR: FINAL_TARGET_RR,
    priorPartialCount,
    firstPartialTaken,
    finalPartialTaken,
    breakEvenSet,
  };

  // If price gaps through both milestones, finish the runner rather than leave
  // a stale 20% position open.
  if (firstPartialTaken && !finalPartialTaken && currentProfitPips >= FINAL_TAKE_PROFIT_PIPS) {
    return actionResult({
      action: 'PARTIAL_CLOSE',
      percent: FINAL_PARTIAL_PERCENT,
      reason: `Final profit milestone reached at +${currentProfitPips.toFixed(1)} pips; close the remaining 20% at +${FINAL_TAKE_PROFIT_PIPS} pips.`,
      confidence: 99,
      evidence: ['eighteen_pip_final_milestone', 'remaining_twenty_percent'],
      metrics,
      stopLoss: entryPrice,
    });
  }

  // +15 pips banks 80%. If a fast move skipped the +10 reconciliation, this
  // same decision also carries the entry-price stop so the remaining 20% is
  // protected immediately.
  if (!firstPartialTaken && currentProfitPips >= FIRST_TAKE_PROFIT_PIPS) {
    return actionResult({
      action: 'PARTIAL_CLOSE',
      percent: FIRST_PARTIAL_PERCENT,
      reason: `First profit milestone reached at +${currentProfitPips.toFixed(1)} pips; close 80% and keep the remaining 20% protected at breakeven.`,
      confidence: 99,
      evidence: ['fifteen_pip_profit_milestone', 'eighty_percent_partial', 'breakeven_remaining_twenty'],
      metrics,
      stopLoss: entryPrice,
    });
  }

  // Breakeven occurs independently at +10 pips, before the first partial.
  if (!breakEvenSet && currentProfitPips >= BREAK_EVEN_TRIGGER_PIPS) {
    return actionResult({
      action: 'MOVE_STOP_TO_BREAKEVEN',
      reason: `Trade reached +${currentProfitPips.toFixed(1)} pips; move SL to entry at the +${BREAK_EVEN_TRIGGER_PIPS} pip protection trigger.`,
      confidence: 99,
      evidence: ['ten_pip_breakeven_trigger', 'no_early_close'],
      metrics,
      stopLoss: entryPrice,
    });
  }

  if (firstPartialTaken && !breakEvenSet) {
    return actionResult({
      action: 'MOVE_STOP_TO_BREAKEVEN',
      reason: 'The 80% first partial is already banked; enforce breakeven on the remaining 20%.',
      confidence: 99,
      evidence: ['partial_already_taken', 'breakeven_required'],
      metrics,
      stopLoss: entryPrice,
    });
  }

  if (firstPartialTaken && !finalPartialTaken) {
    return actionResult({
      action: 'HOLD_TO_TP',
      reason: `80% is banked and the remaining 20% is protected at breakeven; hold for +${FINAL_TAKE_PROFIT_PIPS} pips.`,
      confidence: 95,
      evidence: ['eighty_percent_banked', 'breakeven_protected', 'await_eighteen_pips'],
      metrics,
    });
  }

  return actionResult({
    action: 'HOLD_TO_TP',
    reason: `No profit milestone is due; keep the fixed ${FIXED_STOP_LOSS_PIPS}-pip SL and wait for the +${BREAK_EVEN_TRIGGER_PIPS} pip breakeven trigger.`,
    confidence: 92,
    evidence: ['protective_sl_is_loss_authority', 'await_ten_pip_breakeven'],
    metrics,
  });
}

export function closeUnitsForDecision(currentUnits, decision) {
  const units = Math.floor(Math.abs(finite(currentUnits, 0)));
  if (decision?.action !== 'PARTIAL_CLOSE' || units <= 1) return null;
  const requested = Math.floor(units * clamp(finite(decision.closePercent, 0), 1, 99) / 100);
  return Math.max(1, Math.min(units - 1, requested));
}
