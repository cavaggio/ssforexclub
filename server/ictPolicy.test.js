import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyBoundedIctStopWidening,
  buildIctManipulationProfile,
  classifyIctStrategy,
  computeAdaptiveIctStop,
  computeIctLifecycleConfidence,
  ictEntryConfidence,
  ictHoldMinutes,
  isIctTradeRecord,
} from './ictPolicy.js';

test('routes existing ICT concepts without adding confirmation gates', () => {
  assert.equal(classifyIctStrategy({ silverBulletWindow: true }), 'Silver Bullet');
  assert.equal(classifyIctStrategy({ judasSwing: true }), 'Judas Swing');
  assert.equal(classifyIctStrategy({ turtleSoup: true }), 'Turtle Soup');
  assert.equal(classifyIctStrategy({ powerOf3Distribution: true }), 'Power of Three');
  assert.equal(classifyIctStrategy({ breakerConfirmed: true }), 'Breaker Block');
  assert.equal(classifyIctStrategy({ sweepAligned: true, displacementAligned: true, reversalConfirmed: true, fvgInDir: true }), 'ICT 2022 Model');
  assert.equal(classifyIctStrategy({ inOteZone: true, bosAligned: true }), 'OTE Continuation');
  assert.equal(classifyIctStrategy({ obInDir: true, displacementAligned: true }), 'Order-Block Mitigation');
  assert.equal(classifyIctStrategy({ fvgInDir: true, bosAligned: true }), 'FVG Continuation');
});

test('manipulation profile reacts to repeated rejection wicks and a confirmed sweep', () => {
  const candles = Array.from({ length: 10 }, (_, index) => ({
    open: 0.8120 + index * 0.00001,
    high: 0.8124 + index * 0.00001,
    low: index === 9 ? 0.8108 : 0.8115,
    close: 0.8121 + index * 0.00001,
  }));
  const profile = buildIctManipulationProfile({
    candles,
    atrPrice: 0.0005,
    sweep: { pending: false, sweptPriceLevel: 0.8110 },
    direction: 'long',
  });
  assert.equal(profile.confirmedSweep, true);
  assert.ok(profile.score >= 40);
  assert.ok(profile.atrBufferMultiplier >= 1.45);
});

test('adaptive initial stop sits beyond structural invalidation', () => {
  const result = computeAdaptiveIctStop({
    pair: 'USD_CHF',
    direction: 'long',
    entry: 0.8130,
    zoneLow: 0.8122,
    zoneHigh: 0.8128,
    sweptLevel: 0.8113,
    atrPrice: 0.0006,
    candles: [],
    sweep: { pending: false, sweptPriceLevel: 0.8113 },
  });
  assert.equal(result.ok, true);
  assert.ok(result.stopLoss < 0.8113);
  assert.ok(result.bufferPips >= 5);
});

test('Claude widening is bounded by ATR and minimum RR', () => {
  const result = applyBoundedIctStopWidening({
    pair: 'USD_CHF',
    direction: 'long',
    entry: 0.8130,
    stopLoss: 0.8120,
    targetProfit: 0.8150,
    suggestedExtraPips: 50,
    atrPips: 10,
    minRR: 1.5,
  });
  assert.equal(result.adjusted, true);
  assert.ok(result.extraPips <= 5);
  assert.ok(result.actualRR >= 1.5);
});

test('ICT confidence remains fixed during hold and decays only after hold', () => {
  assert.equal(computeIctLifecycleConfidence({ entryConfidence: 96, minutesElapsed: 10, holdMinutes: 60, lifecycleAction: 'CLOSE' }), 96);
  assert.ok(computeIctLifecycleConfidence({ entryConfidence: 96, minutesElapsed: 90, holdMinutes: 60, lifecycleAction: 'CLOSE' }) < 96);
});

test('ICT entry snapshot helpers recognize strategy and preserve hold data', () => {
  const record = { entryStrategy: 'ICT', entryQualityConfidence: 95, entryExpectedHoldTimeMinutes: 90 };
  assert.equal(isIctTradeRecord(record), true);
  assert.equal(ictEntryConfidence(record), 95);
  assert.equal(ictHoldMinutes(record), 90);
});
