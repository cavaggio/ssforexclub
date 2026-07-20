import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizePprScan } from './scannerEngine.js';

test('PPR normalization reports exact scanned, qualified, watching, and rejected counts', () => {
  const scan = normalizePprScan({
    qualified: [{ pair: 'GBP_USD', status: 'qualified', confidence: 82, rr: 1.8 }],
    watchCandidates: [{ pair: 'EUR_GBP', status: 'hot', reason: 'waiting' }],
    rejected: [{ pair: 'GBP_JPY', status: 'rejected', reason: 'spread' }],
    meta: { pairsScanned: 3, minConfidence: 80, minRR: 1.5 },
  });
  assert.equal(scan.meta.pairsScanned, 3);
  assert.equal(scan.meta.qualifiedCount, 1);
  assert.equal(scan.meta.watchCount, 1);
  assert.equal(scan.meta.rejectedCount, 1);
  assert.equal(scan.meta.accountedFor, 3);
  assert.equal(scan.meta.countInvariantOk, true);
  assert.equal(scan.meta.minConfidence, 80);
});

test('generated dashboard shows PPR watching, count verification, and Auto AI readiness', () => {
  const source = readFileSync(new URL('../components/scanner-status-card.tsx', import.meta.url), 'utf8');
  assert.match(source, /label="Watching"/);
  assert.match(source, /label="Count check"/);
  assert.match(source, /label="Auto AI"/);
  assert.match(source, /LIVE READY/);
  assert.match(source, /PRACTICE READY/);
});
