/**
 * server/ictLifecycleEngine.js
 *
 * PURE ICT trade-management engine. Independent of V3 (does NOT use
 * oandaTradeLifecycle / V3 rules). Decides, from ICT concepts only, what to do
 * with an open ICT trade once its projected hold-time has elapsed.
 *
 *   estimateHoldMinutes(setupType, killzone)  → projected hold for a new trade
 *   reassessIctTrade({ ... })                 → { minutesElapsed, pastHold,
 *                                                 reassessDue, action, reasons }
 *
 * Cadence rule: while elapsed < holdMinutes → always HOLD. Once past hold,
 * a recommendation is "due" every REASSESS_INTERVAL_MIN (30) minutes. The
 * action is ICT-first and protection-only: opposing CHoCH/MSS can justify a
 * breakeven move once the trade has progressed, target progress can justify a
 * partial, and time alone can never liquidate a position. The protective SL
 * remains the sole loss authority.
 */

import { detectChangeOfCharacter } from './oandaInstitutionalFlow.js';
import { detectMSS } from './ictConcepts.js';

export const REASSESS_INTERVAL_MIN = 30;
const SCALP_MAX_HOLD_MINUTES = () => Math.max(
  15,
  parseFloat(process.env.SCALP_MAX_HOLD_MINUTES || '120'),
);
const HOLD_DEFAULT = () => Math.min(
  SCALP_MAX_HOLD_MINUTES(),
  parseFloat(process.env.ICT_HOLD_MINUTES_DEFAULT || '120'),
);

// Projected hold by setup archetype, nudged by killzone quality.
const SETUP_HOLD = {
  'Silver Bullet': 60,
  'Turtle Soup': 90,
  'Judas Reversal': 120,
  'OTE Continuation': 120,
  'MSS Reversal': 120,
};

export function estimateHoldMinutes(setupType, killzone = null) {
  let base = SETUP_HOLD[setupType] ?? HOLD_DEFAULT();
  // Lower-quality session → shorter expected runway.
  if (killzone && killzone.killzoneQuality != null && killzone.killzoneQuality < 80) base = Math.round(base * 0.75);
  return Math.min(base, SCALP_MAX_HOLD_MINUTES());
}

const opposes = (dir, structDir) =>
  (dir === 'long' && structDir === 'bearish') || (dir === 'short' && structDir === 'bullish');

/**
 * @param {Object} a
 * @param {string} a.pair
 * @param {'long'|'short'} a.direction
 * @param {number} a.entryPrice
 * @param {number} a.currentPrice
 * @param {number} a.target1            // ICT target (for progress)
 * @param {Array}  a.candles            // 5M/15M structure candles
 * @param {Date}   a.now
 * @param {number} a.openedAtMs
 * @param {number} a.holdMinutes
 * @param {number|null} a.lastReassessMs
 */
export function reassessIctTrade({
  pair, direction, entryPrice, currentPrice, target1 = null,
  candles = [], now = new Date(), openedAtMs, holdMinutes, lastReassessMs = null,
} = {}) {
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const minutesElapsed = Number.isFinite(openedAtMs) ? Math.max(0, (nowMs - openedAtMs) / 60000) : 0;
  const hold = Number.isFinite(holdMinutes) ? holdMinutes : HOLD_DEFAULT();
  const pastHold = minutesElapsed >= hold;

  // Do not reassess before the projected hold-time elapses.
  if (!pastHold) {
    return { minutesElapsed: +minutesElapsed.toFixed(1), pastHold: false, reassessDue: false, action: 'HOLD', reasons: ['Within projected hold time — hold.'] };
  }

  // Past hold → due every 30 minutes.
  const reassessDue = !Number.isFinite(lastReassessMs) || (nowMs - lastReassessMs) / 60000 >= REASSESS_INTERVAL_MIN;
  if (!reassessDue) {
    return { minutesElapsed: +minutesElapsed.toFixed(1), pastHold: true, reassessDue: false, action: 'HOLD', reasons: ['Past hold but inside 30-min reassessment cadence.'] };
  }

  const reasons = [];
  let action = 'HOLD';

  const targetSpan = Number.isFinite(target1) && Number.isFinite(entryPrice)
    ? Math.abs(target1 - entryPrice)
    : 0;
  const favorableProgress = Number.isFinite(entryPrice) && Number.isFinite(currentPrice)
    ? (direction === 'long' ? currentPrice - entryPrice : entryPrice - currentPrice)
    : 0;
  const targetFraction = targetSpan > 0 ? favorableProgress / targetSpan : 0;

  // 1. Opposing structure is evidence, never an automatic liquidation order.
  const priorTrend = direction === 'long' ? 'bullish' : 'bearish';
  const choch = Array.isArray(candles) && candles.length >= 25 ? detectChangeOfCharacter({ candles, priorTrend, pair }) : null;
  const mss = Array.isArray(candles) && candles.length >= 25 ? detectMSS({ candles, pair }) : null;
  if (choch && opposes(direction, choch.direction)) {
    action = targetFraction >= 0.4 ? 'MOVE_BREAKEVEN' : 'HOLD';
    reasons.push(`Opposing CHoCH (${choch.direction}) recorded; ${action === 'MOVE_BREAKEVEN' ? 'protect at breakeven' : 'do not guess an early exit — keep the original SL'}.`);
  } else if (mss?.confirmed && opposes(direction, mss.direction)) {
    action = targetFraction >= 0.4 ? 'MOVE_BREAKEVEN' : 'HOLD';
    reasons.push(`Opposing MSS (${mss.direction}) recorded; ${action === 'MOVE_BREAKEVEN' ? 'protect at breakeven' : 'do not guess an early exit — keep the original SL'}.`);
  }

  // 2. Target progress → protect. The execution policy separately confirms
  // momentum before it permits the single partial.
  if (action === 'HOLD' && Number.isFinite(target1) && Number.isFinite(entryPrice) && Number.isFinite(currentPrice)) {
    if (targetFraction >= 0.75) { action = 'PARTIAL_CLOSE'; reasons.push(`~${Math.round(targetFraction * 100)}% to target — partial protection is eligible if momentum remains favorable.`); }
    else if (targetFraction >= 0.4) { action = 'MOVE_BREAKEVEN'; reasons.push(`~${Math.round(targetFraction * 100)}% to target — move stop to breakeven.`); }
  }

  // 3. Time/stalling is not a liquidation or stop-tightening trigger.
  if (action === 'HOLD' && minutesElapsed > hold * 1.5) {
    reasons.push('Well past projected hold with no profit milestone; time alone does not override the original protective SL.');
  }

  if (reasons.length === 0) reasons.push('No ICT exit signal — hold.');
  return { minutesElapsed: +minutesElapsed.toFixed(1), pastHold: true, reassessDue: true, action, reasons };
}
