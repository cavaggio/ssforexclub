import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizePprScan } from './scannerEngine.js';

test('PPR normalization reports exact scanned, qualified, watching, and rejected counts', () => {
  const scan = normalizePprScan({
    qualified: [{ pair: 'GBP_USD', status: 'qualified', confidence: 82, rr: 1.8 }],
    watchCandidates: [{ pair: 'EUR_GBP', status: 'hot', reason: 'waiting' }],
    rejected: [{ pair: 'GBP_JPY', status: 'rejected', reason: 'spread' }],
    meta: { pairsScanned: 3, minConfidence: 75, minRR: 1.5 },
  });
  assert.equal(scan.meta.pairsScanned, 3);
  assert.equal(scan.meta.qualifiedCount, 1);
  assert.equal(scan.meta.watchCount, 1);
  assert.equal(scan.meta.rejectedCount, 1);
  assert.equal(scan.meta.accountedFor, 3);
  assert.equal(scan.meta.countInvariantOk, true);
  assert.equal(scan.meta.minConfidence, 75);
});

test('PPR hot candidates keep missing confidence as null instead of converting it to 0%', () => {
  const scan = normalizePprScan({
    qualified: [],
    watchCandidates: [{ pair: 'EUR_GBP', status: 'hot', confidence: null, reason: 'waiting for volume' }],
    rejected: [],
    meta: { pairsScanned: 1 },
  });
  assert.equal(scan.watchCandidates[0].confidence, null);
  assert.equal(scan.watchCandidates[0].entryQualityConfidence, null);
});

test('generated dashboard shows PPR watching, practice readiness, and pending confidence', () => {
  const scannerSource = readFileSync(new URL('../components/scanner-status-card.tsx', import.meta.url), 'utf8');
  const panelSource = readFileSync(new URL('../components/native-engine-scan-panel.tsx', import.meta.url), 'utf8');
  assert.match(scannerSource, /label="Watching"/);
  assert.match(scannerSource, /label="Count check"/);
  assert.match(scannerSource, /label="Auto AI"/);
  assert.match(scannerSource, /LIVE READY/);
  assert.match(scannerSource, /PRACTICE READY/);
  assert.match(panelSource, /PENDING/);
  assert.match(panelSource, /confidenceLabel/);
});
