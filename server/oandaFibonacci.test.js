import test from 'node:test';
import assert from 'node:assert/strict';
import { detectFibSetup } from './oandaFibonacci.js';

function candle(open, high, low, close, index) {
  return {
    open,
    high,
    low,
    close,
    time: new Date(1700000000000 + index * 3600000).toISOString(),
  };
}

function makeBullishH1() {
  const candles = [];
  for (let i = 0; i < 40; i++) {
    const center = 1.1000 + i * 0.00002;
    candles.push(candle(center, center + 0.0008, center - 0.0008, center + 0.0001, i));
  }
  candles[8] = candle(1.0920, 1.0930, 1.0900, 1.0925, 8);
  candles[15] = candle(1.1170, 1.1200, 1.1160, 1.1190, 15);
  return candles;
}

function makeDifferentH4() {
  const candles = [];
  for (let i = 0; i < 40; i++) {
    const center = 1.2000 + i * 0.00002;
    candles.push(candle(center, center + 0.0010, center - 0.0010, center, i));
  }
  candles[7] = candle(1.1500, 1.1510, 1.1000, 1.1400, 7);
  candles[16] = candle(1.2800, 1.3000, 1.2790, 1.2950, 16);
  return candles;
}

test('Fib analysis always uses the H1 impulse even when a valid H4 impulse is supplied', () => {
  const result = detectFibSetup({
    direction: 'long',
    h1Candles: makeBullishH1(),
    h4Candles: makeDifferentH4(),
    currentPrice: 1.1150,
    pair: 'EUR_USD',
  });

  assert.equal(result.timeframeUsed, 'H1');
  assert.equal(result.swingHigh, 1.12);
  assert.equal(result.swingLow, 1.09);
  assert.equal(result.retracementLevels.level382, 1.10854);
  assert.equal(result.entryZoneStatus, 'too_early');
  assert.match(result.reason, /waiting for the pair-specific H1 entry zone/);
  assert.doesNotMatch(result.reason, /H1\/H4/);
});

test('H4 candles cannot produce a Fib setup when H1 has no clean impulse', () => {
  const flatH1 = Array.from(
    { length: 40 },
    (_, i) => candle(1.1000, 1.1005, 1.0995, 1.1000, i),
  );
  const result = detectFibSetup({
    direction: 'long',
    h1Candles: flatH1,
    h4Candles: makeDifferentH4(),
    currentPrice: 1.1500,
    pair: 'EUR_USD',
  });

  assert.equal(result.timeframeUsed, null);
  assert.equal(result.entryZoneStatus, 'unknown');
  assert.match(result.reason, /No clean H1 impulse leg found/);
});
