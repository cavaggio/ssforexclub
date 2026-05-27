/**
 * server/oandaNewsRisk.js
 *
 * Forex news / economic-event risk layer.
 *
 *   getForexNewsRisk(pair, now)   → per-pair risk envelope
 *   reloadForexCalendar()         → force-refresh the in-memory calendar
 *   describeNewsProvider()        → diagnostic info for the dashboard / status route
 *
 * Provider strategy (stub-first):
 *   - Calendar is read from a JSON file whose path is set by
 *     FOREX_NEWS_CALENDAR_PATH (default: server/data/forex-calendar.json).
 *   - If the file is missing, empty, or malformed: the module logs a single
 *     line per process per condition and returns riskLevel='low' (never
 *     blocks). All scoring logic is wired so dropping a real file in later
 *     activates the filter automatically.
 *   - The expected event shape is:
 *         {
 *           time: ISO 8601 UTC string (e.g. "2026-05-26T13:30:00Z"),
 *           currency: "USD" | "GBP" | "EUR" | "JPY" | "CHF" | "CAD" | "AUD" | "NZD" | ...,
 *           impact:  "high" | "medium" | "low",
 *           title:   "CPI MoM" (free text),
 *           actual / forecast / previous: optional
 *         }
 *   - TODO: wire a real provider (Forex Factory scrape, FXStreet, Investing.com,
 *     or paid feed) by replacing readCalendarFromDisk() with a network fetch +
 *     local cache. The contract of getForexNewsRisk() does not change.
 *
 * Configuration (env):
 *   FOREX_NEWS_FILTER_ENABLED                 default 'true'
 *   FOREX_NEWS_HIGH_IMPACT_BLOCK_MINUTES      default 30
 *   FOREX_NEWS_MEDIUM_IMPACT_CAUTION_MINUTES  default 15
 *   FOREX_POST_NEWS_CONFIRMATION_MINUTES      default 60
 *   FOREX_NEWS_CALENDAR_PATH                  default 'server/data/forex-calendar.json'
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const FILTER_ENABLED       = String(process.env.FOREX_NEWS_FILTER_ENABLED ?? 'true').toLowerCase() === 'true';
const HIGH_BLOCK_MIN       = parseInt(process.env.FOREX_NEWS_HIGH_IMPACT_BLOCK_MINUTES     || '30', 10);
const MED_CAUTION_MIN      = parseInt(process.env.FOREX_NEWS_MEDIUM_IMPACT_CAUTION_MINUTES || '15', 10);
const POST_NEWS_CONFIRM_MIN= parseInt(process.env.FOREX_POST_NEWS_CONFIRMATION_MINUTES     || '60', 10);
const CALENDAR_PATH        = process.env.FOREX_NEWS_CALENDAR_PATH
  || resolve(process.cwd(), 'server', 'data', 'forex-calendar.json');

// ─── In-memory cache ──────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;
let _cache = { loadedAt: 0, events: [], source: null, warning: null };
let _missingLogged = false;
let _malformedLogged = false;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseCurrencyPair(pair) {
  const norm = String(pair || '').replace('/', '_').toUpperCase();
  const parts = norm.split('_');
  if (parts.length !== 2) return [];
  // Metals are quoted in USD; "XAU" alone is rarely a news currency, but the
  // USD half still matters for high-impact USD events around the open.
  if (parts[0] === 'XAU' || parts[0] === 'XAG') return ['USD'];
  return parts;
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
  const impact = String(raw.impact || raw.importance || 'low').toLowerCase();
  return {
    time: new Date(epoch).toISOString(),
    epoch,
    currency,
    impact,
    impactRank: impactRank(impact),
    title: String(raw.title || raw.event || raw.name || 'Unknown event'),
    actual:   raw.actual   ?? null,
    forecast: raw.forecast ?? null,
    previous: raw.previous ?? null,
  };
}

async function readCalendarFromDisk() {
  try {
    const raw = await readFile(CALENDAR_PATH, 'utf-8');
    const text = raw.trim();
    if (!text) {
      if (!_missingLogged) {
        console.warn(`[NEWS_RISK] Calendar file at ${CALENDAR_PATH} is empty — events unavailable, filter is permissive`);
        _missingLogged = true;
      }
      return { events: [], source: CALENDAR_PATH, warning: 'empty' };
    }
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (err) {
      if (!_malformedLogged) {
        console.warn(`[NEWS_RISK] Calendar file at ${CALENDAR_PATH} is not valid JSON (${err.message}) — events unavailable`);
        _malformedLogged = true;
      }
      return { events: [], source: CALENDAR_PATH, warning: 'malformed' };
    }
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.events) ? parsed.events : [];
    const events = list.map(normalizeEvent).filter(Boolean);
    return { events, source: CALENDAR_PATH, warning: events.length === 0 ? 'no_events' : null };
  } catch (err) {
    if (err.code === 'ENOENT') {
      if (!_missingLogged) {
        console.warn(
          `[NEWS_RISK] No calendar file at ${CALENDAR_PATH} — filter is permissive. ` +
          `Drop a JSON array of {time, currency, impact, title} to activate.`
        );
        _missingLogged = true;
      }
      return { events: [], source: CALENDAR_PATH, warning: 'missing_file' };
    }
    console.warn(`[NEWS_RISK] Failed to read calendar at ${CALENDAR_PATH}: ${err.message}`);
    return { events: [], source: CALENDAR_PATH, warning: `read_error:${err.code || err.message}` };
  }
}

async function getCalendarCached(now) {
  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  if (nowMs - _cache.loadedAt < CACHE_TTL_MS && _cache.loadedAt > 0) return _cache;
  const fresh = await readCalendarFromDisk();
  _cache = { loadedAt: nowMs, ...fresh };
  return _cache;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Forex-news risk envelope for a single pair.
 *
 * @param {string} pair  OANDA pair string, e.g. 'GBP_JPY' or 'EUR/USD'
 * @param {Date}   now   evaluation time (defaults to wall-clock now)
 * @returns {Promise<{
 *   pair: string,
 *   enabled: boolean,
 *   blocked: boolean,
 *   riskLevel: 'low'|'medium'|'high',
 *   matchingCurrencies: string[],
 *   upcomingEvents: object[],
 *   recentEvents: object[],
 *   postNewsConfirmationRequired: boolean,
 *   reason: string,
 *   provider: { source: string|null, warning: string|null }
 * }>}
 */
export async function getForexNewsRisk(pair, now = new Date()) {
  const currencies = parseCurrencyPair(pair);
  const evalEpoch = now instanceof Date ? now.getTime() : new Date(now).getTime();

  // Filter disabled by env — return a permissive envelope but still include
  // matching currencies for diagnostic purposes.
  if (!FILTER_ENABLED) {
    return {
      pair,
      enabled: false,
      blocked: false,
      riskLevel: 'low',
      matchingCurrencies: currencies,
      upcomingEvents: [],
      recentEvents: [],
      postNewsConfirmationRequired: false,
      reason: 'News filter disabled (FOREX_NEWS_FILTER_ENABLED=false)',
      provider: { source: null, warning: 'disabled' },
    };
  }

  if (currencies.length === 0) {
    return {
      pair,
      enabled: true,
      blocked: false,
      riskLevel: 'low',
      matchingCurrencies: [],
      upcomingEvents: [],
      recentEvents: [],
      postNewsConfirmationRequired: false,
      reason: `Could not parse currencies from pair "${pair}"`,
      provider: { source: null, warning: 'bad_pair' },
    };
  }

  const cal = await getCalendarCached(now);

  // Relevant window: anything within ±max(HIGH_BLOCK, POST_NEWS_CONFIRM) of now.
  const lookWindowMin = Math.max(HIGH_BLOCK_MIN, POST_NEWS_CONFIRM_MIN, MED_CAUTION_MIN) + 30;
  const lookWindowMs = lookWindowMin * 60 * 1000;
  const relevant = cal.events.filter(ev =>
    currencies.includes(ev.currency) &&
    Math.abs(ev.epoch - evalEpoch) <= lookWindowMs
  );

  const upcomingEvents = relevant
    .filter(ev => ev.epoch >= evalEpoch)
    .sort((a, b) => a.epoch - b.epoch)
    .map(ev => ({ ...ev, minutesUntil: Math.round((ev.epoch - evalEpoch) / 60000) }));

  const recentEvents = relevant
    .filter(ev => ev.epoch < evalEpoch)
    .sort((a, b) => b.epoch - a.epoch)
    .map(ev => ({ ...ev, minutesAgo: Math.round((evalEpoch - ev.epoch) / 60000) }));

  // ── Apply scoring rules ─────────────────────────────────────────────────────
  let blocked = false;
  let riskLevel = 'low';
  let postNewsConfirmationRequired = false;
  let reason = 'No upcoming or recent events within risk window';

  // 1. Block on high-impact event within ±HIGH_BLOCK_MIN minutes
  const blockingHigh = relevant.find(ev =>
    ev.impactRank === 3 && Math.abs(ev.epoch - evalEpoch) <= HIGH_BLOCK_MIN * 60 * 1000
  );
  if (blockingHigh) {
    blocked = true;
    riskLevel = 'high';
    const delta = (blockingHigh.epoch - evalEpoch) / 60000;
    if (delta >= 0) {
      reason = `High-impact ${blockingHigh.currency} event "${blockingHigh.title}" in ${Math.round(delta)} minutes — entries blocked`;
    } else {
      reason = `High-impact ${blockingHigh.currency} event "${blockingHigh.title}" ${Math.round(-delta)} minutes ago — post-news volatility still elevated`;
    }
  }

  // 2. If not blocked, downgrade to medium on a nearby medium-impact event
  if (!blocked) {
    const cautionMed = relevant.find(ev =>
      ev.impactRank === 2 && Math.abs(ev.epoch - evalEpoch) <= MED_CAUTION_MIN * 60 * 1000
    );
    if (cautionMed) {
      riskLevel = 'medium';
      const delta = (cautionMed.epoch - evalEpoch) / 60000;
      reason = delta >= 0
        ? `Medium-impact ${cautionMed.currency} event "${cautionMed.title}" in ${Math.round(delta)} minutes — caution`
        : `Medium-impact ${cautionMed.currency} event "${cautionMed.title}" ${Math.round(-delta)} minutes ago — caution`;
    }
  }

  // 3. Independent of blocking: if a high-impact event hit within the past
  //    POST_NEWS_CONFIRM_MIN minutes, require post-news direction confirmation.
  const postNewsHigh = recentEvents.find(ev =>
    ev.impactRank === 3 && ev.minutesAgo <= POST_NEWS_CONFIRM_MIN
  );
  if (postNewsHigh) {
    postNewsConfirmationRequired = true;
    if (!blocked) {
      // Pump risk to at least medium until direction confirms post-news
      if (riskLevel === 'low') riskLevel = 'medium';
      reason = `Post-news window: high-impact ${postNewsHigh.currency} "${postNewsHigh.title}" ${postNewsHigh.minutesAgo}m ago — direction confirmation required`;
    }
  }

  return {
    pair,
    enabled: true,
    blocked,
    riskLevel,
    matchingCurrencies: currencies,
    upcomingEvents,
    recentEvents,
    postNewsConfirmationRequired,
    reason,
    provider: { source: cal.source, warning: cal.warning },
    config: {
      highImpactBlockMinutes: HIGH_BLOCK_MIN,
      mediumImpactCautionMinutes: MED_CAUTION_MIN,
      postNewsConfirmationMinutes: POST_NEWS_CONFIRM_MIN,
    },
  };
}

/**
 * Force a calendar reload on the next call. Useful for tests and when a fresh
 * JSON file is dropped at runtime.
 */
export function reloadForexCalendar() {
  _cache = { loadedAt: 0, events: [], source: null, warning: null };
  _missingLogged = false;
  _malformedLogged = false;
}

/**
 * Diagnostic info for status routes — never throws.
 */
export async function describeNewsProvider() {
  const cal = await getCalendarCached(new Date());
  return {
    enabled: FILTER_ENABLED,
    source: cal.source,
    eventsLoaded: cal.events.length,
    warning: cal.warning,
    config: {
      highImpactBlockMinutes: HIGH_BLOCK_MIN,
      mediumImpactCautionMinutes: MED_CAUTION_MIN,
      postNewsConfirmationMinutes: POST_NEWS_CONFIRM_MIN,
      calendarPath: CALENDAR_PATH,
    },
  };
}
