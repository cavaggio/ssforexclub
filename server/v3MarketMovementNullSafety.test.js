import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeV3MarketMovement } from './v3MarketMovement.js';
import { evaluateV3 } from './v3Engine.js';

function candle({
  time,
  open = 1.1,
  high = 1.101,
  low = 1.099,
  close = 1.1,
} = {}) {
  return { time, open, high, low, close };
}

function flatCandles(count, start = Date.parse('2026-07-17T08:00:00Z'), minutes = 15) {
  return Array.from({ length: count }, (_, index) => candle({
    time: new Date(start + index * minutes * 60_000).toISOString(),
  }));
}

test('market-movement analysis returns a safe no-trigger payload instead of throwing', () => {
  const movement = analyzeV3MarketMovement({
    pair: 'EUR_USD',
    direction: 'long',
    m15Candles: flatCandles(30),
    h1Candles: flatCandles(30, Date.parse('2026-07-15T08:00:00Z'), 60),
    currentPrice: 1.1,
    atrPips: 10,
    structure: { structureTrend: 'ranging', bosDetected: false, chochDetected: false },
    volatility: { volatilityState: 'normal' },
  });

  assert.equal(movement.trigger, null);
  assert.equal(movement.triggerConfirmed, false);
  assert.equal(movement.triggerPrice, 1.1);
  assert.equal(movement.triggerType, null);
  assert.deepEqual(movement.events, []);
});

test('market-movement analysis is null-safe when direction and candles are unavailable', () => {
  const movement = analyzeV3MarketMovement({
    pair: 'USD_JPY',
    direction: null,
    m15Candles: [],
    h1Candles: [],
    currentPrice: null,
    atrPips: null,
    structure: null,
    volatility: null,
  });

  assert.equal(movement.direction, null);
  assert.equal(movement.currentPrice, null);
  assert.equal(movement.trigger, null);
  assert.equal(movement.triggerPrice, null);
  assert.equal(movement.triggerConfirmed, false);
});

test('evaluateV3 returns a rejected analysis rather than crashing when no trigger exists', () => {
  const daily = flatCandles(30, Date.parse('2026-06-01T00:00:00Z'), 24 * 60);
  const h4 = flatCandles(30, Date.parse('2026-07-12T00:00:00Z'), 4 * 60);
  const h1 = flatCandles(40, Date.parse('2026-07-15T00:00:00Z'), 60);
  const m15 = flatCandles(60, Date.parse('2026-07-16T20:00:00Z'), 15);

  const result = evaluateV3({
    pair: 'EUR_USD',
    dailyCandles: daily,
    h4Candles: h4,
    h1Candles: h1,
    m15Candles: m15,
    currentPrice: 1.1,
    atrPips: 10,
    now: new Date('2026-07-17T12:00:00Z'),
  });

  assert.equal(result.qualified, false);
  assert.equal(result.marketMovement.trigger, null);
  assert.equal(result.marketMovement.triggerConfirmed, false);
  assert.ok(result.rejectionReasons.some((reason) => /no fresh market-movement trigger/i.test(reason)));
});
