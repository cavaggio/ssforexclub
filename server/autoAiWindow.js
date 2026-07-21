/**
 * Engine-neutral Auto AI scan and execution windows.
 *
 * Scanning begins at 02:00 ET so every selected engine can build its own watch
 * state before entries are allowed. New orders are blocked until 02:15 ET.
 * This module contains scheduling policy only and imports no strategy code.
 */
export const AUTO_AI_SCAN_WINDOW = Object.freeze({
  startMin: 120,
  endMin: 600,
  timeZone: 'America/New_York',
  weekdaysOnly: true,
});

export const AUTO_AI_EXECUTION_WINDOW = Object.freeze({
  startMin: 135,
  endMin: 600,
  timeZone: 'America/New_York',
  weekdaysOnly: true,
});

// Backward-compatible alias. Existing callers that only need to know whether
// Auto AI should be active should use the broader scan window.
export const AUTO_AI_WINDOW = AUTO_AI_SCAN_WINDOW;

function easternParts(date = new Date(), timeZone = AUTO_AI_SCAN_WINDOW.timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  const rawHour = Number(value('hour') || 0);
  const hour = rawHour === 24 ? 0 : rawHour;
  const minute = Number(value('minute') || 0);
  const weekday = value('weekday');
  return {
    minutesFromMidnight: hour * 60 + minute,
    isWeekend: weekday === 'Sat' || weekday === 'Sun',
  };
}

function inWindow(date, window) {
  const et = easternParts(date, window.timeZone);
  return Boolean(
    !et.isWeekend &&
    et.minutesFromMidnight >= window.startMin &&
    et.minutesFromMidnight < window.endMin
  );
}

export function inAutoAiScanWindow(date = new Date()) {
  return inWindow(date, AUTO_AI_SCAN_WINDOW);
}

export function inAutoAiExecutionWindow(date = new Date()) {
  return inWindow(date, AUTO_AI_EXECUTION_WINDOW);
}

// Backward-compatible alias: Auto AI is considered active while scanning.
export function inAutoAiWindow(date = new Date()) {
  return inAutoAiScanWindow(date);
}

export function autoAiWindowReason() {
  return 'outside_auto_ai_scan_window_02:00-10:00_ET_weekdays';
}

export function autoAiExecutionWindowReason() {
  return 'scan_only_until_02:15_ET_no_new_orders';
}
