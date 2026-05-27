/**
 * server/oandaMarketData.js
 * Fetches real-time pricing and candle data from OANDA v20 REST API.
 */

import { getAccountId, oandaGet } from './oandaClient.js';

/**
 * Fetch account summary (balance, equity, NAV).
 */
export async function getAccountSummary() {
  const accountId = getAccountId();
  const data = await oandaGet(`/v3/accounts/${accountId}/summary`);
  return data.account;
}

/**
 * Fetch available tradeable instruments for the account.
 */
export async function getInstruments() {
  const accountId = getAccountId();
  const data = await oandaGet(`/v3/accounts/${accountId}/instruments`);
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
 */
export async function getPricing(instruments) {
  const list = Array.isArray(instruments) ? instruments.join(',') : instruments;
  const data = await oandaGet(`/v3/accounts/${getAccountId()}/pricing?instruments=${list}`);
  const prices = data.prices || [];

  return prices.map((p) => {
    const bid = parseFloat(p.bids?.[0]?.price || 0);
    const ask = parseFloat(p.asks?.[0]?.price || 0);
    const mid = (bid + ask) / 2;
    const spread = ask - bid;

    // Metals use pip = 0.01 (same divisor as JPY but different instrument class).
    // Forex spread pips use the centralized function which handles JPY vs non-JPY.
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
      bid,
      ask,
      spreadPips,
      time: p.time,
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
 * Returns the raw OANDA trade objects (instrument, currentUnits, price, unrealizedPL, stopLossOrder, …).
 */
export async function getOpenTrades() {
  const accountId = getAccountId();
  const data = await oandaGet(`/v3/accounts/${accountId}/trades?state=OPEN`);
  return data.trades || [];
}

/**
 * Fetch OHLCV candles for a given instrument.
 * @param {string} instrument  e.g. 'EUR_USD'
 * @param {string} granularity e.g. 'M5', 'H1', 'D'
 * @param {number} count       number of candles (max 5000)
 */
export async function getCandles(instrument, granularity = 'M5', count = 100) {
  const data = await oandaGet(
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

  // Overlaps are highest-volume periods
  if (hour >= 12 && hour < 16) return 'London/NewYork Overlap';
  if (hour >= 7 && hour < 9) return 'Tokyo/London Overlap';
  if (hour >= 0 && hour < 2) return 'Sydney/Tokyo Overlap';

  if (hour >= 20 || hour < 0) return 'Sydney';
  if (hour >= 0 && hour < 7) return 'Tokyo';
  if (hour >= 7 && hour < 12) return 'London';
  if (hour >= 12 && hour < 20) return 'NewYork';

  return 'Closed';
}
