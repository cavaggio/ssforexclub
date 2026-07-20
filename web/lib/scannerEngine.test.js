import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeSelectedScan,
  scanEndpointForEngine,
} from './scannerEngine.js';

const ICT_12_PAIRS = [
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
];

test('each selected engine maps to exactly one internal scanner endpoint', () => {
  assert.deepEqual(scanEndpointForEngine('ppr'), {
    engine: 'ppr',
    internalPath: '/api/internal/oanda/ppr-scan',
    logTag: 'PPR_SCANNER_SCAN',
  });
  assert.equal(scanEndpointForEngine('v3').internalPath, '/api/internal/oanda/v3-scan');
  assert.equal(scanEndpointForEngine('ict').internalPath, '/api/internal/oanda/ict');
  assert.equal(scanEndpointForEngine('invalid').internalPath, '/api/internal/oanda/ict');
});

test('PPR normalization strips foreign engine fields and outside-watchlist pairs', () => {
  const scan = normalizeSelectedScan('ppr', {
    qualified: [
      {
        pair: 'GBP_USD',
        status: 'qualified',
        direction: 'long',
        entry: 1.2,
        stopLoss: 1.19,
        takeProfit: 1.215,
        rr: 1.5,
        v3: { score: 99 },
        macro: { macroBias: 'bullish' },
        ppr: { volume: { ratio: 1.8 } },
      },
      { pair: 'EUR_USD', status: 'qualified', v3: { score: 100 } },
    ],
    watchCandidates: [{ pair: 'EUR_GBP', status: 'hot', reason: 'waiting' }],
    rejected: [{ pair: 'GBP_JPY', status: 'late', reason: 'late entry' }],
    meta: { pairsScanned: 4 },
  });

  assert.equal(scan.engine, 'ppr');
  assert.equal(scan.qualified.length, 1);
  assert.equal(scan.watchCandidates.length, 1);
  assert.equal(scan.rejected.length, 1);
  assert.deepEqual(
    [...scan.qualified, ...scan.watchCandidates, ...scan.rejected].map((item) => item.pair).sort(),
    ['EUR_GBP', 'GBP_JPY', 'GBP_USD'].sort(),
  );
  const serialized = JSON.stringify(scan).toLowerCase();
  assert.equal(serialized.includes('"v3"'), false);
  assert.equal(serialized.includes('macro'), false);
  assert.equal(scan.qualified[0].architecture, 'independent_ppr_raw_market_data');
});

test('ICT normalization maps execution-eligible native buy/sell signals and preserves all 12 scanned rows', () => {
  const analyses = ICT_12_PAIRS.map((pair, index) => ({
    pair,
    signal: index === 0 ? 'buy' : index === 1 ? 'sell' : 'none',
    confidence: index < 2 ? 90 : 40,
    rr: index === 0 ? 1.8 : index === 1 ? 1.6 : 1.1,
    ictNarrative: index < 2 ? 'qualified ICT setup' : 'no qualifying ICT setup',
    rejectionReasons: index < 2 ? [] : ['no 5M entry-timing trigger'],
    v3Comparison: { score: 99 },
  }));

  const scan = normalizeSelectedScan('ict', {
    analyses,
    meta: {
      pairsAnalyzed: ICT_12_PAIRS.length,
      executionMinConfidence: 85,
      executionMinRR: 1.5,
    },
  });

  assert.equal(scan.qualified.length, 2);
  assert.equal(scan.rejected.length, 10);
  assert.equal(scan.analyses.length, 12);
  assert.deepEqual(scan.qualified.map((item) => item.direction), ['long', 'short']);
  assert.deepEqual(
    scan.analyses.map((item) => item.pair),
    ICT_12_PAIRS,
  );
  assert.equal(JSON.stringify(scan).includes('v3Comparison'), false);
});

test('ICT directional rows below execution floors are rejected instead of advertised as qualified', () => {
  const scan = normalizeSelectedScan('ict', {
    analyses: [
      { pair: 'USD_CAD', signal: 'sell', confidence: 96, rr: 0.55, rejectionReasons: [] },
      { pair: 'EUR_JPY', signal: 'buy', confidence: 84, rr: 2.0, rejectionReasons: [] },
    ],
    meta: { executionMinConfidence: 85, executionMinRR: 1.5 },
  });

  assert.equal(scan.qualified.length, 0);
  assert.equal(scan.rejected.length, 2);
  assert.match(scan.rejected[0].reason, /risk\/reward below execution threshold/i);
  assert.match(scan.rejected[1].reason, /confidence below execution threshold/i);
});

test('authoritative dashboard generator limits the 1.5R visibility filter to V3 only', () => {
  const source = readFileSync(new URL('../scripts/apply-ppr-scanner-ui.mjs', import.meta.url), 'utf8');
  assert.match(source, /const qualified = selectedEngine === 'v3'/);
  assert.match(source, /const rejected = selectedEngine === 'v3'/);
  assert.match(source, /ICT and PPR\n  \/\/ must retain every native result/);
});
