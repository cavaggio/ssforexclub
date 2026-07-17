import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSelectedScan,
  scanEndpointForEngine,
} from './scannerEngine.js';

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

test('ICT normalization removes display-only comparison data', () => {
  const scan = normalizeSelectedScan('ict', {
    analyses: [
      { pair: 'EUR_USD', signal: 'long', confidence: 90, v3Comparison: { score: 99 } },
      { pair: 'USD_CAD', signal: 'none', rejectionReasons: ['no sweep'] },
    ],
    meta: { pairsAnalyzed: 2 },
  });
  assert.equal(scan.qualified.length, 1);
  assert.equal(scan.rejected.length, 1);
  assert.equal(JSON.stringify(scan).includes('v3Comparison'), false);
});
