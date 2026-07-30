import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function restoreV3WatchlistCompatibility(root = DEFAULT_ROOT) {
  const path = resolve(root, 'server/v3IndependentScanner.js');
  const before = readFileSync(path, 'utf8');
  let after = before;

  after = after.replace(
    `export const DEFAULT_V3_WATCHLIST = Object.freeze([
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
]);`,
    `const DEFAULT_V3_WATCHLIST = [
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
];`,
  );

  after = after.replace(
    `export function configuredV3Watchlist() {
  return [...DEFAULT_V3_WATCHLIST];
}`,
    `function configuredWatchlist() {
  const raw = process.env.FOREX_V3_WATCHLIST || process.env.FOREX_WATCHLIST || '';
  if (!raw.trim()) return DEFAULT_V3_WATCHLIST;
  return [...new Set(raw.split(',').map((pair) => pair.trim().toUpperCase()).filter(Boolean))];
}`,
  );

  after = after.replace(
    `  const hardWatchlist = configuredV3Watchlist();
  const allowedPairs = new Set(hardWatchlist);
  const requestedPairs = Array.isArray(pairs) && pairs.length ? pairs : hardWatchlist;
  const watchlist = [...new Set(
    requestedPairs
      .map((pair) => String(pair || '').trim().toUpperCase())
      .filter((pair) => allowedPairs.has(pair)),
  )];`,
    `  const watchlist = [...new Set(
    (Array.isArray(pairs) && pairs.length ? pairs : configuredWatchlist())
      .map((pair) => String(pair).toUpperCase()),
  )];`,
  );

  after = after.replaceAll('configuredV3Watchlist()', 'configuredWatchlist()');

  for (const marker of [
    'const DEFAULT_V3_WATCHLIST = [',
    'function configuredWatchlist()',
    'process.env.FOREX_V3_WATCHLIST',
  ]) {
    if (!after.includes(marker)) throw new Error(`[V3_WATCHLIST_COMPAT] missing ${marker}`);
  }

  if (after !== before) writeFileSync(path, after, 'utf8');
  console.log(`[V3_WATCHLIST_COMPAT] verified server/v3IndependentScanner.js${after !== before ? ' (restored)' : ''}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  restoreV3WatchlistCompatibility(DEFAULT_ROOT);
}
