import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildIndependentV3Candidate,
  computeV3OnlyEntryQualityConfidence,
} from './v3IndependentScanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function bullishV3(overrides = {}) {
  return {
    direction: 'long',
    score: 78,
    qualified: true,
    earlyTrigger: true,
    slPipsEst: 10,
    premiumDiscount: { premiumDiscountScore: 0.8 },
    liquidityIntent: { intentScore: 0.72 },
    targets: {
      accepted: true,
      tp1: { price: 1.1016, pips: 16, source: 'nearest_liquidity_above' },
    },
    structure: { structureTrend: 'bullish' },
    liquidity: {},
    ...overrides,
  };
}

test('entry-quality confidence is computed from V3 fields only', () => {
  const confidence = computeV3OnlyEntryQualityConfidence(bullishV3());
  assert.equal(confidence, 100);
});

test('candidate direction and geometry come only from native V3 state', () => {
  const candidate = buildIndependentV3Candidate({
    pair: 'AUD_CAD',
    pricing: { mid: 1.1, spreadPips: 1.2 },
    v3: bullishV3(),
    newsRisk: { blocked: false, riskLevel: 'low' },
    session: 'NewYork',
    minRR: 1.5,
  });

  assert.ok(candidate);
  assert.equal(candidate.direction, 'long');
  assert.equal(Object.hasOwn(candidate, 'legacyDirection'), false);
  assert.equal(Object.hasOwn(candidate, 'legacyScannerUsed'), false);
  assert.equal(candidate.architecture, 'independent_v3_raw_market_data');
  assert.equal(candidate.stopLoss < candidate.entry, true);
  assert.equal(candidate.takeProfit > candidate.entry, true);
  assert.equal(candidate.expectedRR, 1.6);
});

test('candidate rejects a target on the wrong side of the V3 direction', () => {
  const candidate = buildIndependentV3Candidate({
    pair: 'AUD_CAD',
    pricing: { mid: 1.1, spreadPips: 1.2 },
    v3: bullishV3({
      targets: {
        accepted: true,
        tp1: { price: 1.0984, pips: 16, source: 'wrong_side_target' },
      },
    }),
    minRR: 1.5,
  });

  assert.equal(candidate, null);
});

test('V3 auto runner has no foreign scanner or shared retrace-watch dependency', () => {
  const source = fs.readFileSync(path.join(__dirname, 'v3AutoTrade.js'), 'utf8');
  assert.equal(source.includes("from './oandaScanner.js'"), false);
  assert.equal(source.includes('scanForexPairs('), false);
  assert.equal(source.includes('legacyQualified'), false);
  assert.equal(source.includes('retraceWatchMode'), false);
  assert.equal(source.includes('getRetraceWatchPairs'), false);
  assert.equal(source.includes('scan?.qualified) ? scan.qualified'), true);
});
