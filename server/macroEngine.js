/**
 * server/macroEngine.js
 *
 * Signal Stack V3 — Macro Risk Engine (ADDITIVE, non-blocking).
 *
 *   analyzeMacroRisk(pair)   → upcoming macro-event risk envelope for a pair
 *   analyzeMacroBias(pair)   → directional macro bias derived from event surprises
 *   reloadMacroCalendar()    → force-refresh the in-memory calendar
 *   describeMacroProvider()  → diagnostics for the dashboard / status route
 *
 * IMPORTANT — this module is purely informational. It is appended onto signals
 * as `signal.macroAnalysis` and surfaced in the dashboard. It NEVER changes
 * whether a signal qualifies, how it is scored, or how a live trade is sized
 * or managed. Treat it as read-only intelligence.
 *
 * Provider strategy (stub-first, mirrors oandaNewsRisk.js):
 *   - The macro calendar is read from a JSON file whose path is set by
 *     FOREX_MACRO_CALENDAR_PATH (default: server/data/macro-calendar.json).
 *   - If the file is missing, empty, or malformed, the engine logs a single
 *     line per process per condition and degrades gracefully to
 *     macroRisk='low' / macroBias='neutral'. It never throws and never blocks.
 *   - To plug in a real provider later (Forex Factory, FXStreet, Investing.com,
 *     Trading Economics, or a paid feed), replace `loadCalendarEvents()` with a
 *     network fetch + local cache. The public contract below does not change.
 *
 * Tracked high-significance event types:
 *   NFP, CPI, PPI, FOMC, ECB, BOE, BOJ, GDP, UNEMPLOYMENT, RETAIL_SALES
 *
 * Expected event shape (all fields except time/currency optional):
 *   {
 *     time:     ISO 8601 UTC (e.g. "2026-06-05T12:30:00Z"),
 *     currency: "USD" | "EUR" | "GBP" | "JPY" | "CHF" | "CAD" | "AUD" | "NZD" | ...,
 *     impact:   "high" | "medium" | "low",
 *     type:     "NFP" | "CPI" | "FOMC" | ... (free text; matched leniently),
 *     title:    "Non-Farm Payrolls",
 *     actual / forecast / previous: numbers (optional — used for bias)
 *   }
 *
 * Configuration (env):
 *   FOREX_MACRO_ENGINE_ENABLED         default 'true'
 *   FOREX_MACRO_CALENDAR_PATH          default 'server/data/macro-calendar.json'
 *   FOREX_MACRO_HIGH_RISK_HOURS        default 24   (high-impact tracked event within → high risk)
 *   FOREX_MACRO_MEDIUM_RISK_HOURS      default 72   (tracked event within → at least medium)
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ENABLED            = String(process.env.FOREX_MACRO_ENGINE_ENABLED ?? 'true').toLowerCase() === 'true';
const HIGH_RISK_HOURS    = parseFloat(process.env.FOREX_MACRO_HIGH_RISK_HOURS   || '24');
const MEDIUM_RISK_HOURS  = parseFloat(process.env.FOREX_MACRO_MEDIUM_RISK_HOURS || '72');
const CALENDAR_PATH      = process.env.FOREX_MACRO_CALENDAR_PATH
  || resolve(process.cwd(), 'server', 'data', 'macro-calendar.json');

// Tracked event types and the patterns that map free-text titles/types onto them.
const TRACKED_EVENTS = [
  { key: 'NFP',          label: 'Non-Farm Payrolls',   patterns: [/nfp/i, /non[-\s]?farm/i, /payroll/i] },
  { key: 'CPI',          label: 'CPI',                 patterns: [/\bcpi\b/i, /consumer price/i, /inflation/i] },
  { key: 'PPI',          label: 'PPI',                 patterns: [/\bppi\b/i, /producer price/i] },
  { key: 'FOMC',         label: 'FOMC Rate Decision',  patterns: [/fomc/i, /fed funds/i, /federal reserve/i, /fed rate/i] },
  { key: 'ECB',          label: 'ECB Rate Decision',   patterns: [/\becb\b/i, /refinancing/i, /european central/i] },
  { key: 'BOE',          label: 'BOE Rate Decision',   patterns: [/\bboe\b/i, /bank of england/i] },
  { key: 'BOJ',          label: 'BOJ Rate Decision',   patterns: [/\bboj\b/i, /bank of japan/i] },
  { key: 'GDP',          label: 'GDP Release',         patterns: [/\bgdp\b/i, /gross domestic/i] },
  { key: 'UNEMPLOYMENT', label: 'Unemployment Report', patterns: [/unemployment/i, /jobless/i, /claimant/i] },
  { key: 'RETAIL_SALES', label: 'Retail Sales',        patterns: [/retail sales/i] },
];

const CACHE_TTL_MS = 5 * 60 * 1000;
let _cache = { loadedAt: 0, events: [], source: null, warning: null };
let _missingLogged = false;
let _malformedLogged = false;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseCurrencyPair(pair) {
  const norm = String(pair || '').replace('/', '_').toUpperCase();
  const parts = norm.split('_');
  if (parts.length !== 2) return [];
  // Metals/indices are USD-quoted; the USD half still drives macro risk.
  if (parts[0] === 'XAU' || parts[0] === 'XAG') return ['USD'];
  return parts;
}

function classifyEventType(raw) {
  const hay = `${raw.type || ''} ${raw.title || raw.event || raw.name || ''}`;
  for (const evt of TRACKED_EVENTS) {
    if (evt.patterns.some((re) => re.test(hay))) return evt.key;
  }
  return null;
}

function impactRank(impact) {
  switch (String(impact || '').toLowerCase()) {
    case 'high':   return 3;
    case 'medium': return 2;
    case 'low':    return 1;
    default:       return 0;
  }
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ts = typeof raw.time === 'string' ? raw.time : raw.timestamp || raw.date;
  const epoch = ts ? Date.parse(ts) : NaN;
  if (!Number.isFinite(epoch)) return null;
  const currency = String(raw.currency || raw.country || raw.ccy || '').toUpperCase();
  if (!currency) return null;
  const trackedType = classifyEventType(raw);
  const impact = String(raw.impact || raw.importance || 'low').toLowerCase();
  return {
    time: new Date(epoch).toISOString(),
    epoch,
    currency,
    impact,
    impactRank: impactRank(impact),
    type: trackedType,                 // null for events we don't track
    title: String(raw.title || raw.event || raw.name || trackedType || 'Macro event'),
    actual:   numericOrNull(raw.actual),
    forecast: numericOrNull(raw.forecast),
    previous: numericOrNull(raw.previous),
  };
}

function numericOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function loadCalendarEvents() {
  const now = Date.now();
  if (now - _cache.loadedAt < CACHE_TTL_MS && _cache.source !== null) {
    return _cache.events;
  }
  try {
    const text = await readFile(CALENDAR_PATH, 'utf8');
    const parsed = JSON.parse(text);
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.events) ? parsed.events : null;
    if (!arr) throw new Error('calendar JSON is not an array');
    const events = arr.map(normalizeEvent).filter(Boolean).sort((a, b) => a.epoch - b.epoch);
    _cache = { loadedAt: now, events, source: CALENDAR_PATH, warning: events.length === 0 ? 'empty' : null };
    if (events.length === 0 && !_missingLogged) {
      console.log(`[MACRO] calendar at ${CALENDAR_PATH} is empty — macro risk defaults to low (drop a real feed to activate).`);
      _missingLogged = true;
    }
    return events;
  } catch (err) {
    if (!_malformedLogged) {
      console.log(`[MACRO] calendar unavailable (${err.message}) — macro risk defaults to low. ${CALENDAR_PATH}`);
      _malformedLogged = true;
    }
    _cache = { loadedAt: now, events: [], source: null, warning: err.message };
    return [];
  }
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * analyzeMacroRisk(pair) → {
 *   macroRisk: 'low' | 'medium' | 'high',
 *   upcomingEvents: [{ time, currency, impact, type, title, hoursUntil }],
 *   hoursUntilNextEvent: number | null,
 *   recommendation: string
 * }
 *
 * Always resolves; never throws. When disabled or no data, returns a low-risk
 * envelope so callers can treat it as a no-op.
 */
export async function analyzeMacroRisk(pair, now = new Date()) {
  const base = {
    macroRisk: 'low',
    upcomingEvents: [],
    hoursUntilNextEvent: null,
    recommendation: 'No tracked macro events on the horizon — standard conditions.',
  };
  if (!ENABLED) {
    return { ...base, recommendation: 'Macro engine disabled — treated as low risk.' };
  }
  try {
    const currencies = parseCurrencyPair(pair);
    if (currencies.length === 0) return base;
    const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
    const events = await loadCalendarEvents();

    const upcoming = events
      .filter((e) => e.currency && currencies.includes(e.currency))
      .filter((e) => e.epoch >= nowMs)
      .map((e) => ({
        time: e.time,
        currency: e.currency,
        impact: e.impact,
        type: e.type,
        title: e.title,
        hoursUntil: +(((e.epoch - nowMs) / 3_600_000)).toFixed(1),
      }));

    if (upcoming.length === 0) return base;

    const hoursUntilNextEvent = upcoming[0].hoursUntil;

    // Risk classification — tracked, high-impact events dominate.
    const trackedSoon = upcoming.filter((e) => e.type && e.hoursUntil <= MEDIUM_RISK_HOURS);
    const highSoon = trackedSoon.filter((e) => impactRank(e.impact) >= 3 && e.hoursUntil <= HIGH_RISK_HOURS);
    const mediumSoon = trackedSoon.filter((e) => impactRank(e.impact) >= 2);

    let macroRisk = 'low';
    if (highSoon.length > 0) macroRisk = 'high';
    else if (trackedSoon.length > 0 || mediumSoon.length > 0) macroRisk = 'medium';

    const next = upcoming[0];
    const nextLabel = next.type
      ? (TRACKED_EVENTS.find((t) => t.key === next.type)?.label || next.title)
      : next.title;

    let recommendation;
    if (macroRisk === 'high') {
      recommendation = `High macro risk: ${next.currency} ${nextLabel} in ${formatHours(hoursUntilNextEvent)}. ` +
        `Expect elevated volatility / spread widening around the release — size conservatively and consider sitting out the window.`;
    } else if (macroRisk === 'medium') {
      recommendation = `Moderate macro risk: ${next.currency} ${nextLabel} in ${formatHours(hoursUntilNextEvent)}. ` +
        `Tradeable, but be mindful of event-driven moves as the release approaches.`;
    } else {
      recommendation = `Low macro risk: next ${next.currency} event (${nextLabel}) is ${formatHours(hoursUntilNextEvent)} away.`;
    }

    return {
      macroRisk,
      upcomingEvents: upcoming.slice(0, 10),
      hoursUntilNextEvent,
      recommendation,
    };
  } catch (err) {
    console.log(`[MACRO] analyzeMacroRisk(${pair}) degraded: ${err.message}`);
    return base;
  }
}

/**
 * analyzeMacroBias(pair) → {
 *   macroBias: 'bullish' | 'bearish' | 'neutral',
 *   strength: number (0–100),
 *   reasons: string[]
 * }
 *
 * Derives a directional lean for the BASE currency of the pair from the most
 * recent tracked-event surprises (actual vs forecast) where data exists.
 * Without surprise data it returns neutral with an explanatory reason.
 * Purely informational — never gates a signal.
 */
export async function analyzeMacroBias(pair, now = new Date()) {
  const neutral = { macroBias: 'neutral', strength: 0, reasons: ['No macro surprise data available — neutral.'] };
  if (!ENABLED) return { macroBias: 'neutral', strength: 0, reasons: ['Macro engine disabled — neutral.'] };
  try {
    const currencies = parseCurrencyPair(pair);
    if (currencies.length !== 2) return neutral;
    const [base, quote] = currencies;
    const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
    const lookbackMs = 7 * 24 * 3_600_000; // recent surprises decay over a week
    const events = await loadCalendarEvents();

    // Recent, tracked, resolved (actual + forecast present) events.
    const resolved = events.filter(
      (e) => e.type && e.actual != null && e.forecast != null &&
        e.epoch <= nowMs && (nowMs - e.epoch) <= lookbackMs,
    );
    if (resolved.length === 0) return neutral;

    const reasons = [];
    let score = 0; // positive → base bullish, negative → base bearish

    for (const e of resolved) {
      const surprise = surpriseSign(e); // +1 stronger-than-expected, -1 weaker, 0 inline
      if (surprise === 0) continue;
      // Higher-than-forecast hard data is generally currency-positive.
      const weight = impactRank(e.impact); // 1..3
      const recency = 1 - Math.min(1, (nowMs - e.epoch) / lookbackMs); // 0..1
      const contribution = surprise * weight * (0.5 + 0.5 * recency);
      const label = TRACKED_EVENTS.find((t) => t.key === e.type)?.label || e.title;
      if (e.currency === base) {
        score += contribution;
        reasons.push(`${base} ${label} ${surprise > 0 ? 'beat' : 'missed'} forecast → base ${surprise > 0 ? 'support' : 'pressure'}.`);
      } else if (e.currency === quote) {
        score -= contribution;
        reasons.push(`${quote} ${label} ${surprise > 0 ? 'beat' : 'missed'} forecast → quote ${surprise > 0 ? 'support' : 'pressure'}.`);
      }
    }

    if (reasons.length === 0) return neutral;

    const strength = Math.min(100, Math.round(Math.abs(score) * 18));
    let macroBias = 'neutral';
    if (score > 0.5) macroBias = 'bullish';
    else if (score < -0.5) macroBias = 'bearish';

    if (macroBias === 'neutral') reasons.push('Net macro surprises roughly balanced — neutral lean.');
    return { macroBias, strength, reasons: reasons.slice(0, 6) };
  } catch (err) {
    console.log(`[MACRO] analyzeMacroBias(${pair}) degraded: ${err.message}`);
    return neutral;
  }
}

function surpriseSign(e) {
  if (e.actual == null || e.forecast == null) return 0;
  const diff = e.actual - e.forecast;
  const tol = Math.abs(e.forecast) * 0.001;
  if (diff > tol) return 1;
  if (diff < -tol) return -1;
  return 0;
}

function formatHours(h) {
  if (h == null) return 'n/a';
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)} days`;
}

export function reloadMacroCalendar() {
  _cache = { loadedAt: 0, events: [], source: null, warning: null };
  _missingLogged = false;
  _malformedLogged = false;
}

export function describeMacroProvider() {
  return {
    enabled: ENABLED,
    calendarPath: CALENDAR_PATH,
    source: _cache.source,
    eventsLoaded: _cache.events.length,
    warning: _cache.warning,
    trackedEventTypes: TRACKED_EVENTS.map((t) => t.key),
    highRiskHours: HIGH_RISK_HOURS,
    mediumRiskHours: MEDIUM_RISK_HOURS,
  };
}
