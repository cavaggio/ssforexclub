import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_V3_FOREX_WATCHLIST,
  getConfiguredV3Watchlist,
  resolveV3ScanPairs,
} from './v3NativeScanner.js';

test('native V3 fallback watchlist contains exactly 12 forex pairs', () => {
  const watchlist = getConfiguredV3Watchlist({});
  assert.equal(DEFAULT_V3_FOREX_WATCHLIST.length, 12);
  assert.equal(watchlist.length, 12);
  assert.deepEqual(watchlist, DEFAULT_V3_FOREX_WATCHLIST);
});

test('V3_FOREX_WATCHLIST overrides FOREX_WATCHLIST', () => {
  const watchlist = getConfiguredV3Watchlist({
    V3_FOREX_WATCHLIST: 'GBP_USD,EUR_USD,USD_JPY',
    FOREX_WATCHLIST: 'AUD_CAD,USD_CAD',
  });
  assert.deepEqual(watchlist, ['GBP_USD', 'EUR_USD', 'USD_JPY']);
});

test('full V3 scan always uses the complete configured watchlist', () => {
  const pairs = resolveV3ScanPairs({
    scanMode: 'full',
    pairs: ['EUR_USD'],
    env: { V3_FOREX_WATCHLIST: 'EUR_USD,GBP_USD,USD_JPY' },
  });
  assert.deepEqual(pairs, ['EUR_USD', 'GBP_USD', 'USD_JPY']);
});

test('near and hot scans remain limited to configured staged subsets', () => {
  const env = { V3_FOREX_WATCHLIST: 'EUR_USD,GBP_USD,USD_JPY' };
  assert.deepEqual(
    resolveV3ScanPairs({ scanMode: 'near', pairs: ['GBP_USD', 'AUD_CAD'], env }),
    ['GBP_USD'],
  );
  assert.deepEqual(
    resolveV3ScanPairs({ scanMode: 'hot', pairs: ['USD_JPY'], env }),
    ['USD_JPY'],
  );
});
