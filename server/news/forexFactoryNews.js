/**
 * server/news/forexFactoryNews.js
 *
 * Live Forex Factory high-impact-news risk layer for the ICT engine.
 *
 * HARD RULE:
 *   - "High" / red-impact Forex Factory events affecting either currency
 *     block NEW trades from 30 minutes before the scheduled release through
 *     30 minutes after the release.
 *   - The live Forex Factory weekly JSON export is the production source of
 *     truth. The local JSON file remains an explicit test/offline fallback.
 *   - If the live feed cannot be refreshed and no still-valid cache exists,
 *     the risk result FAILS CLOSED and blocks new trades.
 *
 * Public contracts:
 *   getNewsRisk({ pair, now, calendar?, cfg? })
 *     -> synchronous deterministic evaluation for tests/legacy callers.
 *   getForexFactoryNewsRisk({ pair, now })
 *     -> async production evaluation with live-feed refresh.
 *   refreshForexFactoryCalendar({ force?, now? })
 *     -> async live-feed refresh.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOCAL_CALENDAR_PATH = process.env.FOREX_FACTORY_CALENDAR_PATH
  || resolve(process.cwd(), 'server', 'data', 'forex-factory-calendar.json');

const DEFAULT_FEED_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const FEED_URL = process.env.FOREX_FACTORY_FEED_URL || DEFAULT_FEED_URL;

const DEFAULT_BLOCK_BEFORE_MIN = 30;
const DEFAULT_BLOCK_AFTER_MIN = 30;
const FEED_REFRESH_MS = Math.max(
  15_000,
  Number(process.env.FOREX_NEWS_FEED_REFRESH_SECONDS || 60) * 1000,
);
const FETCH_TIMEOUT_MS = Math.max(
  3_000,
  Number(process.env.FOREX_NEWS_FEED_TIMEOUT_MS || 10_000),
);

export function newsConfig() {
  return {
    // The production red/high-impact blackout is intentionally non-optional.
    // Keep this field for compatibility and diagnostics; it cannot disable the
    // high-impact production safety rule.
    enabled: true,
    requestedEnabled: String(process.env.FOREX_NEWS_FILTER_ENABLED ?? 'true').toLowerCase() === 'true',
    blockBeforeMin: DEFAULT_BLOCK_BEFORE_MIN,
    blockAfterMin: DEFAULT_BLOCK_AFTER_MIN,
    feedUrl: FEED_URL,
    localCalendarPath: LOCAL_CALENDAR_PATH,
    feedRefreshSeconds: FEED_REFRESH_MS / 1000,
  };
}

let _cache = {
  events: [],
  loadedAt: 0,
  source: null,
  warning: 'not_loaded',
  healthy: false,
};

function nowMsOf(now = new Date()) {
  const ms = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return Number.isFinite(ms) ? ms : Date.now();
}

function normalizeImpact(value) {
  const impact = String(value || '').trim().toLowerCase();
  if (impact === 'high' || impact === 'red') return 'high';
  if (impact === 'medium' || impact === 'orange') return 'medium';
  if (impact === 'low' || impact === 'yellow') return 'low';
  return impact;
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const timeValue = raw.time ?? raw.date ?? raw.datetime ?? raw.timestamp;
  const epoch = timeValue ? Date.parse(String(timeValue)) : NaN;
  const currency = String(raw.currency ?? raw.country ?? raw.ccy ?? '').trim().toUpperCase();
  const impact = normalizeImpact(raw.impact ?? raw.importance);

  if (!Number.isFinite(epoch) || !currency || !impact) return null;

  return {
    time: new Date(epoch).toISOString(),
    epoch,
    currency,
    impact,
    event: String(raw.event ?? raw.title ?? raw.name ?? 'Unknown event'),
    title: String(raw.title ?? raw.event ?? raw.name ?? 'Unknown event'),
    actual: raw.actual ?? null,
    forecast: raw.forecast ?? null,
    previous: raw.previous ?? null,
  };
}

function parseCalendarPayload(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.events)
      ? payload.events
      : [];
  return list.map(normalizeEvent).filter(Boolean);
}

function parseCurrencyPair(pair) {
  const normalized = String(pair || '').replace('/', '_').toUpperCase();
  const parts = normalized.split('_').filter(Boolean);
  if (parts.length !== 2) return [];
  if (parts[0] === 'XAU' || parts[0] === 'XAG') return ['USD'];
  return parts;
}

function loadLocalCalendar() {
  try {
    const text = readFileSync(LOCAL_CALENDAR_PATH, 'utf8').trim();
    if (!text) return { events: [], source: LOCAL_CALENDAR_PATH, warning: 'empty_local_calendar' };
    const events = parseCalendarPayload(JSON.parse(text));
    return {
      events,
      source: LOCAL_CALENDAR_PATH,
      warning: events.length ? null : 'no_parseable_local_events',
    };
  } catch (error) {
    return {
      events: [],
      source: LOCAL_CALENDAR_PATH,
      warning: `local_calendar_unavailable:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function fetchLiveCalendar() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(FEED_URL, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'ssforexclub/forex-factory-news-risk',
        'cache-control': 'no-cache',
      },
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`Forex Factory feed HTTP ${response.status}`);

    const payload = await response.json();
    const events = parseCalendarPayload(payload);
    if (!events.length) throw new Error('Forex Factory feed returned no parseable events');

    return { events, source: FEED_URL, warning: null, healthy: true };
  } finally {
    clearTimeout(timeout);
  }
}

export async function refreshForexFactoryCalendar({ force = false, now = new Date() } = {}) {
  const evalMs = nowMsOf(now);
  const cacheAge = evalMs - Number(_cache.loadedAt || 0);

  if (!force && _cache.loadedAt > 0 && cacheAge >= 0 && cacheAge < FEED_REFRESH_MS) return _cache;

  try {
    const fresh = await fetchLiveCalendar();
    _cache = { ...fresh, loadedAt: evalMs };
    return _cache;
  } catch (error) {
    const warning = error instanceof Error ? error.message : String(error);
    const cacheStillUsable =
      _cache.loadedAt > 0 &&
      _cache.events.length > 0 &&
      cacheAge >= 0 &&
      cacheAge <= 15 * 60 * 1000;

    if (cacheStillUsable) {
      _cache = { ..._cache, warning, healthy: false };
      console.warn(`[NEWS_RISK] Forex Factory refresh failed; using cached calendar: ${warning}`);
      return _cache;
    }

    // Explicit local-calendar fallback is allowed only in tests. Production
    // execution fails closed rather than silently trading without the feed.
    const local = loadLocalCalendar();
    if (local.events.length > 0 && process.env.NODE_ENV === 'test') {
      _cache = {
        events: local.events,
        loadedAt: evalMs,
        source: local.source,
        warning: `live_feed_failed_in_test:${warning}`,
        healthy: false,
      };
      return _cache;
    }

    _cache = {
      events: [],
      loadedAt: evalMs,
      source: FEED_URL,
      warning,
      healthy: false,
    };
    console.error(`[NEWS_RISK] Forex Factory feed unavailable — FAIL-CLOSED: ${warning}`);
    return _cache;
  }
}

function evaluateCalendarRisk({ pair, now = new Date(), calendar = null, cfg = null, feedHealthy = true } = {}) {
  const config = cfg || newsConfig();
  const currencies = parseCurrencyPair(pair);
  const evalMs = nowMsOf(now);
  const events = Array.isArray(calendar) ? calendar.map(normalizeEvent).filter(Boolean) : [];
  const beforeMs = Number(config.blockBeforeMin ?? DEFAULT_BLOCK_BEFORE_MIN) * 60_000;
  const afterMs = Number(config.blockAfterMin ?? DEFAULT_BLOCK_AFTER_MIN) * 60_000;

  const result = {
    enabled: true,
    blocked: false,
    feedUnavailable: false,
    blockReason: null,
    caution: false,
    cautionReason: null,
    events: [],
    matchingCurrencies: currencies,
  };

  // Preserve test/offline configurability when an explicit config object is
  // supplied. Production getForexFactoryNewsRisk() always uses enabled=true.
  if (config.enabled === false) {
    result.enabled = false;
    return result;
  }

  if (!currencies.length) {
    result.blocked = true;
    result.feedUnavailable = true;
    result.blockReason = `Cannot evaluate Forex Factory news for invalid pair "${pair}" — blocking new trade.`;
    return result;
  }

  for (const ev of events) {
    if (!currencies.includes(ev.currency)) continue;
    const deltaMs = ev.epoch - evalMs;
    const inWindow = evalMs >= ev.epoch - beforeMs && evalMs <= ev.epoch + afterMs;
    if (!inWindow) continue;

    const tagged = {
      ...ev,
      inWindow: true,
      minutesUntil: Math.round(deltaMs / 60_000),
      minutesAgo: Math.round((-deltaMs) / 60_000),
    };
    result.events.push(tagged);

    if (ev.impact === 'high') {
      result.blocked = true;
      if (!result.blockReason) {
        const when = deltaMs >= 0
          ? `in ${Math.round(deltaMs / 60_000)} minutes`
          : `${Math.round((-deltaMs) / 60_000)} minutes ago`;
        result.blockReason =
          `Forex Factory RED/HIGH news blackout active for ${ev.currency}: ${ev.event} — ${when}. New entries blocked.`;
      }
    } else if (ev.impact === 'medium') {
      result.caution = true;
      if (!result.cautionReason) result.cautionReason = `Medium-impact news near for ${ev.currency}: ${ev.event}`;
    }
  }

  if (!feedHealthy && !events.length) {
    result.blocked = true;
    result.feedUnavailable = true;
    result.blockReason = 'Forex Factory news feed unavailable or stale — blocking new trades until the calendar is available.';
  }

  return result;
}

/**
 * Synchronous/backward-compatible contract. Passing calendar explicitly is
 * recommended for deterministic tests. Otherwise it evaluates the current
 * cached feed; production callers should use getForexFactoryNewsRisk().
 */
export function getNewsRisk({ pair, now = new Date(), calendar = null, cfg = null } = {}) {
  const cached = calendar ? null : _cache;
  const cal = Array.isArray(calendar) ? calendar : cached?.events || [];
  return evaluateCalendarRisk({
    pair,
    now,
    calendar: cal,
    cfg,
    feedHealthy: calendar ? true : cached?.healthy === true,
  });
}

/** Production async contract: refresh live Forex Factory data, then evaluate. */
export async function getForexFactoryNewsRisk({ pair, now = new Date() } = {}) {
  const config = newsConfig();
  const cal = await refreshForexFactoryCalendar({ now });
  return evaluateCalendarRisk({
    pair,
    now,
    calendar: cal.events,
    cfg: config,
    feedHealthy: cal.healthy === true,
  });
}

export function pairCurrencies(pair) {
  return parseCurrencyPair(pair);
}

export function __resetCalendarCache() {
  _cache = { events: [], loadedAt: 0, source: null, warning: 'reset', healthy: false };
}
