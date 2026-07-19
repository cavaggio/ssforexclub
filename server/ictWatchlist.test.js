import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuredIctWatchlist, DEFAULT_ICT_WATCHLIST } from './ictWatchlist.js';

test('ICT core watchlist exactly mirrors the V3 12-pair market universe', () => {
  assert.deepEqual(DEFAULT_ICT_WATCHLIST, [
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
});

test('environment configuration can add pairs but cannot remove the 12 core pairs', () => {
  const watchlist = configuredIctWatchlist({
    ICT_PAIRS: 'eur_usd,usd_cad,xau_usd',
  });

  assert.deepEqual(watchlist.slice(0, 12), [...DEFAULT_ICT_WATCHLIST]);
  assert.equal(watchlist.length, 13);
  assert.equal(watchlist.at(-1), 'XAU_USD');
});
