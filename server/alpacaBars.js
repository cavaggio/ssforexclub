import express from 'express';

const router = express.Router();

const DATA_BASE_URL = 'https://data.alpaca.markets';

function getAlpacaMarketDataCredentials() {
  const key = process.env.ALPACA_LIVE_API_KEY;
  const secret = process.env.ALPACA_LIVE_API_SECRET;

  if (!key || !secret) {
    throw new Error('Alpaca LIVE market data credentials not configured in backend environment variables');
  }

  return { key, secret };
}

function parseSymbols(value, max = 500) {
  return String(value || '')
    .split(',')
    .map(symbol => symbol.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, max);
}

function chunk(items, size = 100) {
  const groups = [];

  for (let i = 0; i < items.length; i += size) {
    groups.push(items.slice(i, i + size));
  }

  return groups;
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeLatestBar(symbol, bar) {
  return {
    symbol,
    open: num(bar?.o ?? bar?.open),
    high: num(bar?.h ?? bar?.high),
    low: num(bar?.l ?? bar?.low),
    close: num(bar?.c ?? bar?.close),
    volume: num(bar?.v ?? bar?.volume),
    timestamp: bar?.t ?? bar?.timestamp ?? null,
    source: 'alpaca',
  };
}

async function alpacaDataGet(pathname, params = {}) {
  const { key, secret } = getAlpacaMarketDataCredentials();

  const url = new URL(pathname, DATA_BASE_URL);

  Object.entries(params).forEach(([paramKey, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(paramKey, String(value));
    }
  });

  const response = await fetch(url, {
    headers: {
      'APCA-API-KEY-ID': key,
      'APCA-API-SECRET-KEY': secret,
    },
  });

  const text = await response.text();

  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text };
  }

  if (response.status === 401) {
    const err = new Error('Alpaca authorization failed — check ALPACA_LIVE_API_KEY and ALPACA_LIVE_API_SECRET.');
    err.status = 401;
    throw err;
  }

  if (!response.ok) {
    const err = new Error(body?.message || body?.error || `Alpaca data request failed (${response.status})`);
    err.status = response.status;
    throw err;
  }

  return body;
}

router.get('/bars/latest', async (req, res) => {
  try {
    const symbols = parseSymbols(req.query.symbols, 500);
    const feed = String(req.query.feed || process.env.ALPACA_STOCK_FEED || 'iex');

    if (!symbols.length) {
      return res.status(400).json({ error: 'symbols query parameter is required' });
    }

    const bars = [];

    for (const group of chunk(symbols, 100)) {
      const body = await alpacaDataGet('/v2/stocks/bars/latest', {
        symbols: group.join(','),
        feed,
      });

      const rawBars = body.bars || body;

      group.forEach(symbol => {
        if (rawBars?.[symbol]) {
          bars.push(normalizeLatestBar(symbol, rawBars[symbol]));
        }
      });
    }

    res.json({
      source: 'alpaca',
      environment: 'live',
      feed,
      bars,
      total: bars.length,
      requested: symbols.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const status = err.status || 503;

    res.status(status).json({
      error: err instanceof Error ? err.message : 'Alpaca latest bars unavailable',
    });
  }
});

export default router;