/**
 * server/news/forexFactoryNews.js
 *
 * Pluggable ForexFactory-style economic-calendar news risk for the ICT engine.
 * Independent of V3. Safe-by-default: reads a LOCAL JSON cache/fallback
 * (server/data/forex-factory-calendar.json) so it works without live
 * scraping/API access. A live fetcher can be plugged in later behind the same
 * `getNewsRisk` contract.
 *
 *   getNewsRisk({ pair, now, calendar?, cfg? })
 *     → { enabled, blocked, blockReason, caution, cautionReason, events[] }
 *
 * Rules:
 *   - High-impact event affecting EITHER currency of the pair, within
 *     [event - BEFORE, event + AFTER] → blocked, with reason
 *     "High-impact news window active for {currency}: {eventName}".
 *   - Medium-impact within window → caution only (never auto-blocks).
 *   - Disabled (FOREX_NEWS_FILTER_ENABLED=false) → never blocks.
 *
 * Calendar event shape: { currency, impact:'high'|'medium'|'low', event, time(ISO) }.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CALENDAR_PATH = process.env.FOREX_FACTORY_CALENDAR_PATH
  || resolve(process.cwd(), 'server', 'data', 'forex-factory-calendar.json');

export function newsConfig() {
  return {
    enabled: String(process.env.FOREX_NEWS_FILTER_ENABLED ?? 'true').toLowerCase() === 'true',
    blockBeforeMin: parseFloat(process.env.FOREX_NEWS_HIGH_IMPACT_BLOCK_MINUTES_BEFORE || '30'),
    blockAfterMin: parseFloat(process.env.FOREX_NEWS_HIGH_IMPACT_BLOCK_MINUTES_AFTER || '30'),
  };
}

let _cache = null;
function loadCalendar() {
  if (_cache) return _cache;
  try {
    const txt = readFileSync(CALENDAR_PATH, 'utf8');
    const parsed = JSON.parse(txt);
    _cache = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.events) ? parsed.events : [];
  } catch {
    _cache = []; // missing/unreadable calendar → no news data, never throws
  }
  return _cache;
}

/** Currencies impacted by a pair (e.g. EUR_USD → ['EUR','USD'], XAU_USD → ['XAU','USD']). */
export function pairCurrencies(pair) {
  return String(pair || '').split('_').filter(Boolean);
}

const norm = (s) => String(s || '').toLowerCase();

export function getNewsRisk({ pair, now = new Date(), calendar = null, cfg = null } = {}) {
  const config = cfg || newsConfig();
  const result = { enabled: config.enabled, blocked: false, blockReason: null, caution: false, cautionReason: null, events: [] };
  if (!config.enabled) return result;

  const events = Array.isArray(calendar) ? calendar : loadCalendar();
  const ccys = new Set(pairCurrencies(pair));
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const beforeMs = config.blockBeforeMin * 60_000;
  const afterMs = config.blockAfterMin * 60_000;

  for (const ev of events) {
    if (!ev || !ccys.has(String(ev.currency))) continue;
    const evMs = Date.parse(ev.time);
    if (!Number.isFinite(evMs)) continue;
    const inWindow = nowMs >= evMs - beforeMs && nowMs <= evMs + afterMs;
    if (!inWindow) continue;
    const impact = norm(ev.impact);
    const tagged = { currency: ev.currency, impact, event: ev.event, time: ev.time, inWindow: true };
    result.events.push(tagged);
    if (impact === 'high') {
      result.blocked = true;
      if (!result.blockReason) result.blockReason = `High-impact news window active for ${ev.currency}: ${ev.event}`;
    } else if (impact === 'medium') {
      result.caution = true;
      if (!result.cautionReason) result.cautionReason = `Medium-impact news near for ${ev.currency}: ${ev.event}`;
    }
  }
  return result;
}

// Test/maintenance hook — drop the in-memory calendar cache.
export function __resetCalendarCache() { _cache = null; }
