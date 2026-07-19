/**
 * Engine-neutral Auto AI execution window.
 *
 * This module contains scheduling policy only. It imports no engine, scanner,
 * strategy evaluator, or engine-owned time helper.
 */
export const AUTO_AI_WINDOW = Object.freeze({
  startMin: 120,
  endMin: 600,
  timeZone: 'America/New_York',
  weekdaysOnly: true,
});

function easternParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: AUTO_AI_WINDOW.timeZone,
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

export function inAutoAiWindow(date = new Date()) {
  const et = easternParts(date);
  return Boolean(
    !et.isWeekend &&
    et.minutesFromMidnight >= AUTO_AI_WINDOW.startMin &&
    et.minutesFromMidnight < AUTO_AI_WINDOW.endMin
  );
}

export function autoAiWindowReason() {
  return 'outside_auto_ai_execution_window_02:00-10:00_ET_weekdays';
}
