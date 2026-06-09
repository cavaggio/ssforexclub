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
 * action is ICT-first: opposing CHoCH/MSS → CLOSE; target progress → partial /
 * breakeven; stalling well past hold → tighten. This module only RECOMMENDS;
 * applying actions is gated elsewhere (ICT_AUTO_MANAGE, default off).
 */

import { detectChangeOfCharacter } from './oandaInstitutionalFlow.js';
import { detectMSS } from './ictConcepts.js';

export const REASSESS_INTERVAL_MIN = 30;
const HOLD_DEFAULT = () => parseFloat(process.env.ICT_HOLD_MINUTES_DEFAULT || '120');

// Projected hold by setup archetype, nudged by killzone quality.
const SETUP_HOLD = {
  'Silver Bullet': 60,
  'Turtle Soup': 90,
  'Judas Reversal': 120,
  'OTE Continuation': 120,
  'MSS Reversal': 180,
};

export function estimateHoldMinutes(setupType, killzone = null) {
  let base = SETUP_HOLD[setupType] ?? HOLD_DEFAULT();
  // Lower-quality session → shorter expected runway.
  if (killzone && killzone.killzoneQuality != null && killzone.killzoneQuality < 80) base = Math.round(base * 0.75);
  return base;
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

  // 1. Opposing structure shift against the position → close.
  const priorTrend = direction === 'long' ? 'bullish' : 'bearish';
  const choch = Array.isArray(candles) && candles.length >= 25 ? detectChangeOfCharacter({ candles, priorTrend, pair }) : null;
  const mss = Array.isArray(candles) && candles.length >= 25 ? detectMSS({ candles, pair }) : null;
  if (choch && opposes(direction, choch.direction)) { action = 'CLOSE'; reasons.push(`Opposing CHoCH (${choch.direction}) against ${direction} — close.`); }
  else if (mss?.confirmed && opposes(direction, mss.direction)) { action = 'CLOSE'; reasons.push(`Opposing MSS (${mss.direction}) against ${direction} — close.`); }

  // 2. Target progress → protect (only if not already closing).
  if (action === 'HOLD' && Number.isFinite(target1) && Number.isFinite(entryPrice) && Number.isFinite(currentPrice)) {
    const span = Math.abs(target1 - entryPrice);
    const progressed = direction === 'long' ? currentPrice - entryPrice : entryPrice - currentPrice;
    const frac = span > 0 ? progressed / span : 0;
    if (frac >= 0.75) { action = 'PARTIAL_CLOSE'; reasons.push(`~${Math.round(frac * 100)}% to target — take partial / protect.`); }
    else if (frac >= 0.4) { action = 'MOVE_BREAKEVEN'; reasons.push(`~${Math.round(frac * 100)}% to target — move stop to breakeven.`); }
  }

  // 3. Stalling well past hold with little progress → tighten.
  if (action === 'HOLD' && minutesElapsed > hold * 1.5) {
    action = 'TIGHTEN_STOP'; reasons.push('Well past projected hold with no resolution — tighten stop.');
  }

  if (reasons.length === 0) reasons.push('No ICT exit signal — hold.');
  return { minutesElapsed: +minutesElapsed.toFixed(1), pastHold: true, reassessDue: true, action, reasons };
}
