/**
 * ICT scanner watchlist configuration.
 *
 * The 12 core instruments intentionally mirror V3's default market universe,
 * but the values live in an ICT-owned module so the strategy engines remain
 * completely independent. Environment configuration may add instruments, but
 * it cannot silently remove any of the 12 required core pairs.
 */

export const DEFAULT_ICT_WATCHLIST = Object.freeze([
  'EUR_USD',
  'GBP_USD',
  'USD_JPY',
  'USD_CAD',
  'USD_CHF',
  'AUD_USD',
  'NZD_USD',
  'EUR_GBP',
  'EUR_CHF',
  'AUD_CAD',
  'GBP_JPY',
  'EUR_JPY',
]);

function parsePairs(value) {
  return String(value || '')
    .split(',')
    .map((pair) => pair.trim().toUpperCase())
    .filter(Boolean);
}

export function configuredIctWatchlist(env = process.env) {
  const configured = parsePairs(env.ICT_PAIRS || env.FOREX_WATCHLIST || '');
  return [...new Set([...DEFAULT_ICT_WATCHLIST, ...configured])];
}
