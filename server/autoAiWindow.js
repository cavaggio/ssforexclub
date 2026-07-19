import { etParts } from './ictTime.js';

/**
 * Engine-neutral Auto AI execution window.
 *
 * This module contains scheduling policy only. It must never import an engine,
 * scanner, strategy evaluator, or execution module.
 */
export const AUTO_AI_WINDOW = Object.freeze({
  startMin: 120,
  endMin: 600,
  timeZone: 'America/New_York',
  weekdaysOnly: true,
});

export function inAutoAiWindow(date = new Date()) {
  const et = etParts(date);
  return Boolean(
    et &&
    !et.isWeekend &&
    et.minutesFromMidnight >= AUTO_AI_WINDOW.startMin &&
    et.minutesFromMidnight < AUTO_AI_WINDOW.endMin
  );
}

export function autoAiWindowReason() {
  return 'outside_auto_ai_execution_window_02:00-10:00_ET_weekdays';
}
