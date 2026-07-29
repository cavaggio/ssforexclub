/**
 * Engine-aware Auto AI scan and execution windows.
 *
 * All engines begin scanning at 02:00 ET so they can build watch state before
 * entries are allowed. V3, PPR, and ICT may all submit new orders from 02:15 ET. The scanner starts at 02:00 ET so every engine can warm its watch state before execution.
 */
export const AUTO_AI_SCAN_WINDOW = Object.freeze({
  startMin: 120,
  endMin: 600,
  timeZone: 'America/New_York',
  weekdaysOnly: true,
});

export const AUTO_AI_EXECUTION_WINDOWS = Object.freeze({
  v3: Object.freeze({
    startMin: 135,
    endMin: 600,
    timeZone: 'America/New_York',
    weekdaysOnly: true,
  }),
  ppr: Object.freeze({
    startMin: 135,
    endMin: 600,
    timeZone: 'America/New_York',
    weekdaysOnly: true,
  }),
  ict: Object.freeze({
    startMin: 135,
    endMin: 600,
    timeZone: 'America/New_York',
    weekdaysOnly: true,
  }),
});

// Backward-compatible alias for callers that still import one execution window.
export const AUTO_AI_EXECUTION_WINDOW = AUTO_AI_EXECUTION_WINDOWS.v3;
export const AUTO_AI_WINDOW = AUTO_AI_SCAN_WINDOW;

function normalizeEngine(value) {
  const engine = String(value || 'v3').toLowerCase();
  return Object.hasOwn(AUTO_AI_EXECUTION_WINDOWS, engine) ? engine : 'v3';
}

export function executionWindowForEngine(engine) {
  return AUTO_AI_EXECUTION_WINDOWS[normalizeEngine(engine)];
}

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

export function inAutoAiExecutionWindow(date = new Date(), engine = 'v3') {
  return inWindow(date, executionWindowForEngine(engine));
}

export function inAutoAiWindow(date = new Date()) {
  return inAutoAiScanWindow(date);
}

export function autoAiWindowReason() {
  return 'outside_auto_ai_scan_window_02:00-10:00_ET_weekdays';
}

export function autoAiExecutionWindowReason(engine = 'v3') {
  const normalized = normalizeEngine(engine);
  const start = '02:15';
  return `${normalized}_scan_only_until_${start}_ET_no_new_orders`;
}
