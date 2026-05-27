import express from 'express';

const router = express.Router();

const TRADING_BASE_URL = 'https://api.alpaca.markets';
const ASSETS_URL = `${TRADING_BASE_URL}/v2/assets?status=active&asset_class=us_equity`;

const ALLOWED_EXCHANGES = new Set(['NASDAQ', 'NYSE', 'AMEX', 'ARCA', 'BATS']);

function getAlpacaAssetCredentials() {
  const key = process.env.ALPACA_LIVE_API_KEY;
  const secret = process.env.ALPACA_LIVE_API_SECRET;

  if (!key || !secret) {
    throw new Error('Alpaca LIVE credentials not configured in backend environment variables');
  }

  return { key, secret };
}

function passesQualityFilter(asset) {
  if (!asset) return false;
  if (asset.status !== 'active') return false;
  if (asset.tradable !== true) return false;
  if (asset.asset_class && asset.asset_class !== 'us_equity') return false;
  if (asset.exchange && !ALLOWED_EXCHANGES.has(asset.exchange)) return false;
  if (typeof asset.symbol !== 'string' || asset.symbol.trim().length === 0) return false;

  // Keep the market universe clean for scan logic.
  // Removes preferred shares, warrants, special share classes, etc.
  if (asset.symbol.includes('.')) return false;
  if (asset.symbol.includes('/')) return false;
  if (asset.symbol.includes('-')) return false;

  return true;
}

router.get('/assets/test', (_req, res) => {
  res.json({
    ok: true,
    route: '/api/alpaca/assets/test',
    environment: 'live',
    credentialsLoaded: Boolean(
      process.env.ALPACA_LIVE_API_KEY &&
      process.env.ALPACA_LIVE_API_SECRET
    ),
    timestamp: new Date().toISOString(),
  });
});

router.get('/assets', async (_req, res) => {
  try {
    const { key, secret } = getAlpacaAssetCredentials();

    const response = await fetch(ASSETS_URL, {
      headers: {
        'APCA-API-KEY-ID': key,
        'APCA-API-SECRET-KEY': secret,
      },
    });

    const body = await response.json().catch(() => []);

    if (response.status === 401) {
      return res.status(401).json({
        error: 'Alpaca authorization failed — check ALPACA_LIVE_API_KEY, ALPACA_LIVE_API_SECRET, and live account access.',
      });
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: body?.message || body?.error || `Alpaca assets request failed (${response.status})`,
      });
    }

    const rawAssets = Array.isArray(body) ? body : [];

    const symbols = [...new Set(
      rawAssets
        .filter(passesQualityFilter)
        .map(asset => asset.symbol.trim().toUpperCase())
    )].sort();

    res.json({
      symbols,
      total: symbols.length,
      source: 'alpaca',
      environment: 'live',
      url: '/v2/assets?status=active&asset_class=us_equity',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({
      error: err instanceof Error ? err.message : 'Alpaca assets unavailable',
    });
  }
});

export default router;