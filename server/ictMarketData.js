/**
 * ICT Intelligence market-data router.
 *
 * Executable FX pairs use the existing request-scoped OANDA client. The three
 * analysis-only instruments use Yahoo's chart endpoint with liquid futures
 * contracts as proxies:
 *   XAU/USD -> GC=F, US30 -> YM=F, US500 -> ES=F.
 *
 * This module returns the same normalized candle shape as oandaMarketData.js.
 * It never places orders and never converts proxy symbols into broker symbols.
 */

import { getCandles as getOandaCandles } from './oandaMarketData.js';
import { getIctInstrumentMeta } from './ictInstrumentCatalog.js';

const YAHOO_BASE_URL = String(process.env.ICT_YAHOO_CHART_BASE_URL || 'https://query1.finance.yahoo.com/v8/finance/chart').replace(/\/$/, '');

const GRANULARITY_MAP = Object.freeze({
  M5: { interval: '5m', range: '5d' },
  M15: { interval: '15m', range: '1mo' },
  H1: { interval: '60m', range: '3mo' },
  H4: { interval: '60m', range: '3mo', aggregateHours: 4 },
  D: { interval: '1d', range: '1y' },
  W: { interval: '1wk', range: '5y' },
  M: { interval: '1mo', range: '10y' },
});

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isoFromEpochSeconds(value) {
  const timestamp = finite(value);
  return timestamp == null ? null : new Date(timestamp * 1000).toISOString();
}

export function parseYahooChart(payload = {}) {
  const result = payload?.chart?.result?.[0];
  if (!result) {
    const message = payload?.chart?.error?.description || payload?.chart?.error?.code || 'Yahoo chart result missing';
    throw new Error(message);
  }

  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quote = result?.indicators?.quote?.[0] || {};
  const opens = Array.isArray(quote.open) ? quote.open : [];
  const highs = Array.isArray(quote.high) ? quote.high : [];
  const lows = Array.isArray(quote.low) ? quote.low : [];
  const closes = Array.isArray(quote.close) ? quote.close : [];
  const volumes = Array.isArray(quote.volume) ? quote.volume : [];

  const candles = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const time = isoFromEpochSeconds(timestamps[i]);
    const open = finite(opens[i]);
    const high = finite(highs[i]);
    const low = finite(lows[i]);
    const close = finite(closes[i]);
    if (!time || [open, high, low, close].some((value) => value == null)) continue;
    candles.push({
      time,
      open,
      high,
      low,
      close,
      volume: finite(volumes[i]) ?? 0,
    });
  }
  return candles;
}

export function aggregateCandles(candles = [], hours = 4) {
  const bucketMs = Math.max(1, Number(hours) || 4) * 60 * 60 * 1000;
  const buckets = new Map();

  for (const candle of candles) {
    const timestamp = Date.parse(candle?.time);
    if (!Number.isFinite(timestamp)) continue;
    const bucket = Math.floor(timestamp / bucketMs) * bucketMs;
    const existing = buckets.get(bucket);
    if (!existing) {
      buckets.set(bucket, {
        time: new Date(bucket).toISOString(),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: Number(candle.volume) || 0,
      });
      continue;
    }
    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume += Number(candle.volume) || 0;
  }

  return [...buckets.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

export async function getYahooIctCandles(instrument, granularity = 'M5', count = 100, {
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('ICT Yahoo market data requires fetch');

  const meta = getIctInstrumentMeta(instrument);
  if (meta.dataSource !== 'yahoo' || !meta.sourceSymbol) {
    throw new Error(`${instrument} is not configured for the ICT Yahoo feed`);
  }

  const config = GRANULARITY_MAP[granularity];
  if (!config) throw new Error(`Unsupported ICT granularity: ${granularity}`);

  const url = new URL(`${YAHOO_BASE_URL}/${encodeURIComponent(meta.sourceSymbol)}`);
  url.searchParams.set('interval', config.interval);
  url.searchParams.set('range', config.range);
  url.searchParams.set('includePrePost', 'false');
  url.searchParams.set('events', 'div,splits');

  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Mozilla/5.0 SignalStack-ICT/1.0',
    },
    signal: AbortSignal.timeout(Number(process.env.ICT_MARKET_DATA_TIMEOUT_MS || 10_000)),
  });

  if (!response.ok) {
    throw new Error(`ICT market-data request failed for ${meta.displaySymbol}: HTTP ${response.status}`);
  }

  const payload = await response.json();
  let candles = parseYahooChart(payload);
  if (config.aggregateHours) candles = aggregateCandles(candles, config.aggregateHours);

  const requestedCount = Math.max(1, Math.trunc(Number(count) || 100));
  return candles.slice(-requestedCount);
}

export async function getIctCandles(instrument, granularity = 'M5', count = 100, options = {}) {
  const meta = getIctInstrumentMeta(instrument);
  if (meta.dataSource === 'yahoo') {
    return getYahooIctCandles(instrument, granularity, count, options);
  }
  return getOandaCandles(instrument, granularity, count, options);
}
