/**
 * server/oandaCalibration.test.js
 *
 * Tests for the self-improvement layer that maps capture ratio →
 * auto-adjusted rejection threshold. Pin the math so a future tweak to
 * the bands surfaces as a test failure.
 *
 * Run with:   node --test server/oandaCalibration.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRealizedR,
  getExpectedRR,
  aggregateMonthlyRR,
  computeRollingCapture,
  thresholdForCaptureRatio,
  getCalibrationSnapshot,
} from './oandaCalibration.js';

function trade({ timestamp, expectedRR, result, pnl, riskAmount = 100, entryRiskRewardRatio }) {
  return {
    id: `${timestamp}_test`,
    timestamp,
    expectedRR,
    entryRiskRewardRatio,
    result,
    pnl,
    riskAmount,
  };
}

test('computeRealizedR: win at full TP = +3R; loss at SL = -1R', () => {
  assert.equal(computeRealizedR({ result: 'win',  pnl:  300, riskAmount: 100 }), 3.0);
  assert.equal(computeRealizedR({ result: 'loss', pnl: -100, riskAmount: 100 }), -1.0);
  assert.equal(computeRealizedR({ result: 'pending', pnl: null, riskAmount: 100 }), null);
});

test('getExpectedRR: prefers expectedRR over entryRiskRewardRatio', () => {
  assert.equal(getExpectedRR({ expectedRR: 2.4, entryRiskRewardRatio: 3.0 }), 2.4);
  assert.equal(getExpectedRR({ entryRiskRewardRatio: 2.8 }), 2.8);
});

test('aggregateMonthlyRR: groups resolved trades by UTC month with avg + capture', () => {
  const trades = [
    trade({ timestamp: '2026-04-05T10:00:00Z', expectedRR: 2.5, result: 'win',  pnl:  200 }),
    trade({ timestamp: '2026-04-18T10:00:00Z', expectedRR: 2.2, result: 'loss', pnl: -100 }),
    trade({ timestamp: '2026-05-02T10:00:00Z', expectedRR: 2.0, result: 'win',  pnl:  150 }),
    trade({ timestamp: '2026-05-29T10:00:00Z', expectedRR: 3.0, result: 'win',  pnl:  280 }),
  ];
  const buckets = aggregateMonthlyRR(trades);
  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].month, '2026-04');
  assert.equal(buckets[0].sampleCount, 2);
  assert.equal(buckets[1].month, '2026-05');
  assert.equal(buckets[1].sampleCount, 2);
  assert.equal(buckets[1].winRate, 1.0);
});

test('aggregateMonthlyRR: skips trades without expectedRR or realizedR', () => {
  const trades = [
    trade({ timestamp: '2026-05-01T10:00:00Z', expectedRR: 2.5, result: 'win', pnl: 200 }),
    { id: 'a', timestamp: '2026-05-10T10:00:00Z', result: 'pending', pnl: null, riskAmount: 100 },
    { id: 'b', timestamp: '2026-05-15T10:00:00Z', result: 'win', pnl: 100 }, // no expectedRR, no entryRR
  ];
  const buckets = aggregateMonthlyRR(trades);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].sampleCount, 1);
});

test('thresholdForCaptureRatio: maps bands monotonically', () => {
  assert.equal(thresholdForCaptureRatio(1.0),  1.75);
  assert.equal(thresholdForCaptureRatio(0.95), 1.75);
  assert.equal(thresholdForCaptureRatio(0.85), 1.85);
  assert.equal(thresholdForCaptureRatio(0.75), 2.00);
  assert.equal(thresholdForCaptureRatio(0.65), 2.15);   // user's 60-70% band
  assert.equal(thresholdForCaptureRatio(0.55), 2.30);
  assert.equal(thresholdForCaptureRatio(0.40), 2.50);
  assert.equal(thresholdForCaptureRatio(-0.2), 2.50);
});

test('thresholdForCaptureRatio: null/NaN → default', () => {
  assert.equal(thresholdForCaptureRatio(null), 1.75);
  assert.equal(thresholdForCaptureRatio(NaN),  1.75);
});

test('computeRollingCapture: uses most-recent N trades', () => {
  const trades = Array.from({ length: 80 }, (_, i) =>
    trade({
      timestamp: new Date(2026, 4, i + 1).toISOString(),
      expectedRR: 2.5,
      result: 'win',
      pnl: 200,
    }),
  );
  const rolling = computeRollingCapture(trades);
  assert.equal(rolling.sampleCount, 60);                 // LOOKBACK_TRADES
  assert.equal(rolling.captureRatio, 0.8);               // 2.0 realised / 2.5 expected
});

test('getCalibrationSnapshot: <10 samples → default threshold + reason', () => {
  const trades = [
    trade({ timestamp: '2026-05-01T10:00:00Z', expectedRR: 2.5, result: 'win', pnl: 200 }),
    trade({ timestamp: '2026-05-02T10:00:00Z', expectedRR: 2.0, result: 'loss', pnl: -100 }),
  ];
  const snap = getCalibrationSnapshot(trades);
  assert.equal(snap.calibratedRejectionThreshold, 1.75);
  assert.equal(snap.eligibleForAdjustment, false);
  assert.ok(snap.adjustmentReason.includes('Insufficient'));
});

test('getCalibrationSnapshot: 60-70% capture ratio → tighten to 2.15 (user-specified band)', () => {
  // 15 trades, expectedRR 3.0 each, half win at +3R, half lose at -1R.
  // sumExpected = 45; sumRealized = (8 * 3) + (7 * -1) = 17; ratio = 17/45 ≈ 0.38 → 2.50
  // Adjust to hit ~0.65: 13 wins at +2.0R (avg), 2 losses at -1R, expectedRR 2.5
  // sumExpected = 15 × 2.5 = 37.5; sumRealized = 13×2.0 + 2×-1 = 24; ratio ≈ 0.64 → 2.15
  const trades = [
    ...Array.from({ length: 13 }, (_, i) =>
      trade({
        timestamp: `2026-05-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
        expectedRR: 2.5,
        result: 'win',
        pnl: 200,                                 // 2.0R on 100 risk
      }),
    ),
    ...Array.from({ length: 2 }, (_, i) =>
      trade({
        timestamp: `2026-05-${String(20 + i).padStart(2, '0')}T10:00:00Z`,
        expectedRR: 2.5,
        result: 'loss',
        pnl: -100,
      }),
    ),
  ];
  const snap = getCalibrationSnapshot(trades);
  assert.equal(snap.eligibleForAdjustment, true);
  assert.ok(
    snap.rolling.captureRatio >= 0.55 && snap.rolling.captureRatio < 0.85,
    `captureRatio expected 0.55–0.85, got ${snap.rolling.captureRatio}`,
  );
  assert.ok(
    snap.calibratedRejectionThreshold > 1.75,
    `threshold expected > default, got ${snap.calibratedRejectionThreshold}`,
  );
});

test('getCalibrationSnapshot: high capture ratio (≥0.95) → default threshold', () => {
  // All wins at exactly the expected RR.
  const trades = Array.from({ length: 15 }, (_, i) =>
    trade({
      timestamp: `2026-05-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
      expectedRR: 2.5,
      result: 'win',
      pnl: 250,    // 2.5R on 100 risk
    }),
  );
  const snap = getCalibrationSnapshot(trades);
  assert.equal(snap.eligibleForAdjustment, true);
  assert.equal(snap.calibratedRejectionThreshold, 1.75);
  assert.ok(snap.rolling.captureRatio >= 0.95);
});
