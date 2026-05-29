/**
 * server/oandaMarketData.js
 *
 * Fetches real-time pricing and candle data from OANDA v20 REST API.
 *
 * 2026-05-27 multi-tenant refactor: every async function now accepts an
 * optional `{ client }` argument carrying a request-scoped OANDA client
 * (from `createOandaClient` in oandaClient.js). When omitted, the legacy
 * env-based default client is used — this is the dev-fallback path.
 *
 * Backward-compatible signatures: existing callers (3 args, no options) keep
 * working. New code passes options as the trailing arg.
 */

import { getAccountId, oandaGet } from './oandaClient.js';
import { isStrictUserPath, getRequestContext } from './requestContext.js';

/**
 * Internal helper. If a per-request client is provided, use it directly.
 * Otherwise fall back to the legacy module-level helpers (which themselves
 * delegate to the default env-based client).
 *
 * Inside a `runUserScoped` block (every authenticated `/api/internal/oanda/*`
 * request), the fallback is FORBIDDEN — calling without a `{ client }` arg
 * throws. This prevents a silent leak where a missing argument routes the
 * scan to the platform's env credentials.
 */
function resolveAccountId(client) {
  if (client && client.accountId) return client.accountId;
  if (isStrictUserPath()) {
    const ctx = getRequestContext();
    throw new Error(
      `Strict user-scoped path attempted to resolve accountId without a per-request client. ` +
        `Expected accountId for this request was "${ctx?.accountId ?? '<unknown>'}". ` +
        `This is a defense-in-depth guard against the default env-based client leaking ` +
        `another user's data into a per-user scan.`,
    );
  }
  return getAccountId();
}

function resolveGet(client) {
  if (client && typeof client.get === 'function') return (path) => client.get(path);
  if (isStrictUserPath()) {
    throw new Error(
      `Strict user-scoped path attempted to call OANDA without a per-request client. ` +
        `Refusing default env-based fallback to prevent cross-tenant leak.`,
    );
  }
  return (path) => oandaGet(path);
}

/**
 * Fetch account summary (balance, equity, NAV).
 *
 * @param {Object} [options]
 * @param {Object} [options.client]  per-request OANDA client (preferred)
 */
export async function getAccountSummary(options = {}) {
  const accountId = resolveAccountId(options.client);
  const get = resolveGet(options.client);
  const data = await get(`/v3/accounts/${accountId}/summary`);
  return data.account;
}

/**
 * Fetch available tradeable instruments for the account.
 */
export async function getInstruments(options = {}) {
  const accountId = resolveAccountId(options.client);
  const get = resolveGet(options.client);
  const data = await get(`/v3/accounts/${accountId}/instruments`);
  return data.instruments || [];
}

/**
 * Calculate spread in pips for a forex instrument.
 *
 *   JPY pairs  (USD_JPY, EUR_JPY, …): 1 pip = 0.01  → multiplier = 100
 *   Other forex (EUR_USD, GBP_USD, …): 1 pip = 0.0001 → multiplier = 10,000
 *
 * Accepts instrument names in 'USD_JPY' or 'USD/JPY' format.
 * Returns NaN for non-finite inputs.
 */
export function calculateForexSpreadPips(bid, ask, instrument) {
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return NaN;
  const normalizedInstrument = String(instrument).replace('/', '_').toUpperCase();
  const pipMultiplier = normalizedInstrument.includes('JPY') ? 100 : 10000;
  return Number((Math.abs(ask - bid) * pipMultiplier).toFixed(1));
}

/**
 * Fetch real-time bid/ask pricing for a comma-separated list of instruments.
 * Returns enriched objects: { instrument, bid, ask, mid, spread, spreadPips }
 *
 * @param {string|string[]} instruments
 * @param {Object} [options]
 * @param {Object} [options.client]
 */
export async function getPricing(instruments, options = {}) {
  const list = Array.isArray(instruments) ? instruments.join(',') : instruments;
  const accountId = resolveAccountId(options.client);
  const get = resolveGet(options.client);
  const data = await get(`/v3/accounts/${accountId}/pricing?instruments=${list}`);
  const prices = data.prices || [];

  return prices.map((p) => {
    const bid = parseFloat(p.bids?.[0]?.price || 0);
    const ask = parseFloat(p.asks?.[0]?.price || 0);
    const mid = (bid + ask) / 2;
    const spread = ask - bid;

    const isMetals = p.instrument === 'XAU_USD' || p.instrument === 'XAG_USD';
    const spreadPips = isMetals
      ? Number((Math.abs(ask - bid) * 100).toFixed(1))
      : calculateForexSpreadPips(bid, ask, p.instrument);

    console.log('[OANDA_PRICING_RAW]', {
      instrument: p.instrument,
      rawBid: p.bids?.[0]?.price,
      rawAsk: p.asks?.[0]?.price,
      closeoutBid: p.closeoutBid,
      closeoutAsk: p.closeoutAsk,
      bid, ask, spreadPips, time: p.time,
    });

    return {
      instrument: p.instrument,
      bid: +bid.toFixed(6),
      ask: +ask.toFixed(6),
      mid: +mid.toFixed(6),
      spread: +spread.toFixed(6),
      spreadPips,
      tradeable: p.tradeable,
      status: p.status,
      time: p.time,
    };
  });
}

/**
 * Fetch all currently open trades for the account.
 * Returns the raw OANDA trade objects (instrument, currentUnits, price,
 * unrealizedPL, stopLossOrder, …).
 */
export async function getOpenTrades(options = {}) {
  const accountId = resolveAccountId(options.client);
  const get = resolveGet(options.client);
  const data = await get(`/v3/accounts/${accountId}/trades?state=OPEN`);
  return data.trades || [];
}

/**
 * Fetch OHLCV candles for a given instrument.
 * @param {string} instrument  e.g. 'EUR_USD'
 * @param {string} granularity e.g. 'M5', 'H1', 'D'
 * @param {number} count       number of candles (max 5000)
 * @param {Object} [options]
 * @param {Object} [options.client]
 */
export async function getCandles(instrument, granularity = 'M5', count = 100, options = {}) {
  const get = resolveGet(options.client);
  const data = await get(
    `/v3/instruments/${instrument}/candles?granularity=${granularity}&count=${count}&price=M`
  );
  const candles = data.candles || [];

  return candles
    .filter((c) => c.complete)
    .map((c) => ({
      time: c.time,
      open: parseFloat(c.mid.o),
      high: parseFloat(c.mid.h),
      low: parseFloat(c.mid.l),
      close: parseFloat(c.mid.c),
      volume: c.volume,
    }));
}

/**
 * Determine current forex trading session based on UTC hour.
 * Returns: 'Sydney' | 'Tokyo' | 'London' | 'NewYork' | 'Overlap'
 */
export function getForexSession() {
  const hour = new Date().getUTCHours();
  if (hour >= 12 && hour < 16) return 'London/NewYork Overlap';
  if (hour >= 7  && hour < 9)  return 'Tokyo/London Overlap';
  if (hour >= 0  && hour < 2)  return 'Sydney/Tokyo Overlap';
  if (hour >= 20 || hour < 0)  return 'Sydney';
  if (hour >= 0  && hour < 7)  return 'Tokyo';
  if (hour >= 7  && hour < 12) return 'London';
  if (hour >= 12 && hour < 20) return 'NewYork';
  return 'Closed';
}
