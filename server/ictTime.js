/**
 * server/ictTime.js
 *
 * ICT Engine — New-York-time killzone & macro awareness (DST-aware).
 *
 * ICT defines killzones and macros in America/New_York wall-clock time, which
 * shifts with US daylight saving. Rather than hard-code a UTC offset, we read
 * the ET hour/minute/weekday off each candle timestamp via Intl (the platform
 * tz database handles EST/EDT automatically).
 *
 * Window constants are exported and editable. All windows are expressed in
 * ET minutes-from-midnight. PURE / side-effect free.
 */

const ET_TZ = 'America/New_York';

const _fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: ET_TZ,
  hour12: false,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * Wall-clock New-York parts for a Date/ISO/ms input.
 *   → { hour 0..23, minute 0..59, weekday 'Mon'.., minutesFromMidnight, isWeekend }
 */
export function etParts(input = new Date()) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  const parts = {};
  for (const p of _fmt.formatToParts(d)) parts[p.type] = p.value;
  // Intl with hour12:false can emit '24' at midnight in some runtimes — normalise.
  let hour = parseInt(parts.hour, 10) % 24;
  const minute = parseInt(parts.minute, 10);
  const weekday = parts.weekday;
  return {
    hour,
    minute,
    weekday,
    minutesFromMidnight: hour * 60 + minute,
    isWeekend: weekday === 'Sat' || weekday === 'Sun',
  };
}

const HM = (h, m = 0) => h * 60 + m;

// ─── Killzones (ET) ──────────────────────────────────────────────────────────
// quality 0–100 — Silver Bullet > London/NY opens > Asian.
export const KILLZONES = [
  { name: 'Asian',                  start: HM(20),    end: HM(24),    quality: 55 },
  { name: 'London',                 start: HM(2),     end: HM(5),     quality: 85 },
  { name: 'New York AM',            start: HM(7),     end: HM(10),    quality: 90 },
  { name: 'New York AM (Silver Bullet)', start: HM(10), end: HM(11),  quality: 95 },
  { name: 'New York PM',            start: HM(13, 30), end: HM(16),   quality: 80 },
];

// ─── Macros (ET) — 20-min high-conviction windows inside the killzones ────────
export const MACROS = [
  { name: 'New York AM macro', start: HM(9, 50),  end: HM(10, 10), quality: 92 },
  { name: 'New York PM macro', start: HM(13, 10), end: HM(13, 40), quality: 88 },
];

export const SILVER_BULLET = { start: HM(10), end: HM(11) }; // 10:00–11:00 ET

function within(mins, win) {
  // [start, end) — Asian's end is 24:00 so the exclusive bound is fine.
  return mins >= win.start && mins < win.end;
}

/**
 * Which killzone (if any) the given time falls in.
 *   → { currentKillzone, inKillzone, killzoneQuality }
 */
export function currentKillzone(input = new Date()) {
  const et = etParts(input);
  if (!et) return { currentKillzone: null, inKillzone: false, killzoneQuality: 0 };
  for (const kz of KILLZONES) {
    if (within(et.minutesFromMidnight, kz)) {
      return { currentKillzone: kz.name, inKillzone: true, killzoneQuality: kz.quality };
    }
  }
  return { currentKillzone: null, inKillzone: false, killzoneQuality: 0 };
}

/**
 * Whether an ICT macro window is active.
 *   → { activeMacro, macroWindow, macroQuality }
 */
export function activeMacro(input = new Date()) {
  const et = etParts(input);
  if (!et) return { activeMacro: null, macroWindow: null, macroQuality: 0 };
  for (const m of MACROS) {
    if (within(et.minutesFromMidnight, m)) {
      const hh = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
      return { activeMacro: m.name, macroWindow: `${hh(m.start)}–${hh(m.end)} ET`, macroQuality: m.quality };
    }
  }
  return { activeMacro: null, macroWindow: null, macroQuality: 0 };
}

/** Silver Bullet window (10:00–11:00 ET). */
export function inSilverBulletWindow(input = new Date()) {
  const et = etParts(input);
  if (!et) return false;
  return within(et.minutesFromMidnight, SILVER_BULLET);
}
