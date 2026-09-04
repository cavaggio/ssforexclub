/**
 * server/oandaNewsRisk.js
 *
 * Shared Forex news risk adapter used by V3/legacy scanner paths.
 * Production source of truth: the live Forex Factory weekly JSON export.
 *
 * HARD RULE:
 *   High/red-impact events affecting either currency block new trades from
 *   30 minutes before through 30 minutes after the scheduled release.
 *
 * The underlying live provider lives in server/news/forexFactoryNews.js.
 * Feed refreshes are cached briefly and fail closed when no usable calendar is
 * available, so a broken news feed cannot silently permit a new trade.
 */

import {
  getForexFactoryNewsRisk,
  refreshForexFactoryCalendar,
  newsConfig as forexFactoryNewsConfig,
  pairCurrencies as forexFactoryPairCurrencies,
} from './news/forexFactoryNews.js';

const FILTER_ENABLED = String(process.env.FOREX_NEWS_FILTER_ENABLED ?? 'true').toLowerCase() === 'true';
const HIGH_BLOCK_MIN = 30;
const MED_CAUTION_MIN = 15;

function parsePair(pair) {
  return forexFactoryPairCurrencies(pair);
}

function riskLevelFromRisk(risk) {
  if (risk?.blocked) return 'high';
  if (risk?.caution) return 'medium';
  return 'low';
}

function eventForDisplay(event, evalMs) {
  const deltaMs = Number(event?.epoch) - evalMs;
  return {
    time: event?.time,
    epoch: event?.epoch,
    currency: event?.currency,
    impact: event?.impact,
    impactRank: event?.impact === 'high' ? 3 : event?.impact === 'medium' ? 2 : 1,
    title: event?.title || event?.event || 'Unknown event',
    event: event?.event || event?.title || 'Unknown event',
    actual: event?.actual ?? null,
    forecast: event?.forecast ?? null,
    previous: event?.previous ?? null,
    minutesUntil: deltaMs >= 0 ? Math.round(deltaMs / 60000) : null,
    minutesAgo: deltaMs < 0 ? Math.round(-deltaMs / 60000) : null,
  };
}

/**
 * Shared per-pair news envelope.
 *
 * This adapter always consults the live Forex Factory risk layer. The live
 * layer uses the 30-minute red/high-impact blackout on both sides of release.
 */
export async function getForexNewsRisk(pair, now = new Date()) {
  const evalDate = now instanceof Date ? now : new Date(now);
  const evalMs = evalDate.getTime();
  const currencies = parsePair(pair);

  if (!FILTER_ENABLED) {
    return {
      pair,
      enabled: false,
      blocked: false,
      feedUnavailable: false,
      riskLevel: 'low',
      matchingCurrencies: currencies,
      upcomingEvents: [],
      recentEvents: [],
      postNewsConfirmationRequired: false,
      reason: 'News filter disabled (FOREX_NEWS_FILTER_ENABLED=false)',
      provider: { source: null, warning: 'disabled' },
      config: {
        highImpactBlockMinutes: HIGH_BLOCK_MIN,
        highImpactBlockMinutesBefore: HIGH_BLOCK_MIN,
        highImpactBlockMinutesAfter: HIGH_BLOCK_MIN,
        mediumImpactCautionMinutes: MED_CAUTION_MIN,
      },
    };
  }

  const risk = await getForexFactoryNewsRisk({ pair, now: evalDate });
  const allEvents = Array.isArray(risk?.events) ? risk.events : [];
  const upcomingEvents = allEvents
    .filter((event) => Number(event.epoch) >= evalMs)
    .sort((a, b) => Number(a.epoch) - Number(b.epoch))
    .map((event) => eventForDisplay(event, evalMs));
  const recentEvents = allEvents
    .filter((event) => Number(event.epoch) < evalMs)
    .sort((a, b) => Number(b.epoch) - Number(a.epoch))
    .map((event) => eventForDisplay(event, evalMs));

  return {
    pair,
    enabled: true,
    blocked: risk.blocked === true,
    feedUnavailable: risk.feedUnavailable === true,
    riskLevel: riskLevelFromRisk(risk),
    matchingCurrencies: currencies,
    upcomingEvents,
    recentEvents,
    postNewsConfirmationRequired: false,
    reason: risk.blockReason || risk.cautionReason || 'No Forex Factory red-impact blackout active',
    provider: {
      source: forexFactoryNewsConfig().feedUrl,
      warning: risk.feedUnavailable ? risk.blockReason : null,
    },
    config: {
      highImpactBlockMinutes: HIGH_BLOCK_MIN,
      highImpactBlockMinutesBefore: HIGH_BLOCK_MIN,
      highImpactBlockMinutesAfter: HIGH_BLOCK_MIN,
      mediumImpactCautionMinutes: MED_CAUTION_MIN,
      feedRefreshSeconds: forexFactoryNewsConfig().feedRefreshSeconds,
    },
  };
}

/** Force the live Forex Factory calendar to refresh immediately. */
export async function reloadForexCalendar() {
  return refreshForexFactoryCalendar({ force: true, now: new Date() });
}

/** Diagnostic info for scanner/status routes. */
export async function describeNewsProvider() {
  const config = forexFactoryNewsConfig();
  const calendar = await refreshForexFactoryCalendar({ now: new Date() });
  return {
    enabled: FILTER_ENABLED,
    source: config.feedUrl,
    eventsLoaded: Array.isArray(calendar.events) ? calendar.events.length : 0,
    healthy: calendar.healthy === true,
    warning: calendar.warning || null,
    config: {
      highImpactBlockMinutes: HIGH_BLOCK_MIN,
      highImpactBlockMinutesBefore: HIGH_BLOCK_MIN,
      highImpactBlockMinutesAfter: HIGH_BLOCK_MIN,
      mediumImpactCautionMinutes: MED_CAUTION_MIN,
      feedRefreshSeconds: config.feedRefreshSeconds,
    },
  };
}
