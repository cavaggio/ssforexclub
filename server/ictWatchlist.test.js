import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { configuredIctWatchlist, DEFAULT_ICT_WATCHLIST } from './ictWatchlist.js';

const REQUIRED_ICT_PAIRS = [
  'EUR_USD',
  'GBP_USD',
  'USD_JPY',
  'GBP_JPY',
];

test('ICT watchlist contains exactly the four approved pairs', () => {
  assert.deepEqual(DEFAULT_ICT_WATCHLIST, REQUIRED_ICT_PAIRS);
  assert.deepEqual(configuredIctWatchlist(), REQUIRED_ICT_PAIRS);
});

test('stale environment variables cannot reintroduce removed ICT instruments', () => {
  assert.deepEqual(configuredIctWatchlist({
    ICT_PAIRS: 'EUR_USD,USD_CAD,XAU_USD',
    FOREX_WATCHLIST: 'AUD_USD,NZD_USD',
  }), REQUIRED_ICT_PAIRS);
});

test('ICT engine fallback is enforced through the ICT-owned watchlist module', () => {
  const source = readFileSync(new URL('./ictEngine.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ configuredIctWatchlist \} from '\.\/ictWatchlist\.js';/);
  assert.match(source, /const ICT_PAIRS = configuredIctWatchlist\(\);/);
  assert.doesNotMatch(source, /DEFAULT_ICT_PAIRS/);
});
