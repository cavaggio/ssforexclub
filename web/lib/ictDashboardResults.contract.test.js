import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSelectedScan } from './scannerEngine.js';

const PAIRS = [
  'EUR_USD', 'GBP_USD', 'USD_JPY', 'USD_CAD', 'USD_CHF', 'AUD_USD',
  'NZD_USD', 'EUR_GBP', 'EUR_CHF', 'AUD_CAD', 'GBP_JPY', 'EUR_JPY',
];

test('ICT dashboard contract keeps one visible normalized row per scanned pair', () => {
  const analyses = PAIRS.map((pair, index) => ({
    pair,
    signal: index === 0 ? 'buy' : index === 1 ? 'sell' : 'none',
    rr: index < 2 ? 1.5 : 0.8,
    rejectionReasons: index < 2 ? [] : ['below current setup threshold'],
  }));

  const scan = normalizeSelectedScan('ict', { analyses, meta: { pairsAnalyzed: 12 } });
  const visible = [...scan.qualified, ...scan.rejected];

  assert.equal(visible.length, 12);
  assert.deepEqual(visible.map((item) => item.pair).sort(), [...PAIRS].sort());
  assert.deepEqual(scan.qualified.map((item) => item.direction), ['long', 'short']);
});
