import test from 'node:test';
import assert from 'node:assert/strict';
import { findUntestedZones } from './dailyMarketStudy.js';

function candle(time, open, high, low, close) {
  return { time, open, high, low, close };
}

test('daily study retains highs and lows that later candles have not retested', () => {
  const zones = findUntestedZones([
    candle('2026-07-20', 1.5, 2, 1, 1.8),
    candle('2026-07-21', 1.8, 3, 1.5, 2.7),
    candle('2026-07-22', 2.7, 2.8, 2.2, 2.4),
  ], 'D');

  assert.ok(zones.some((zone) => zone.type === 'untested_low' && zone.price === 1));
  assert.ok(zones.some((zone) => zone.type === 'untested_high' && zone.price === 3));
  assert.ok(zones.some((zone) => zone.type === 'untested_low' && zone.price === 1.5));
  assert.ok(!zones.some((zone) => zone.type === 'untested_high' && zone.price === 2));
});

test('daily study ignores malformed candles rather than storing invalid zones', () => {
  const zones = findUntestedZones([
    { time: 'bad', open: 1, high: 0, low: 1, close: 1 },
    candle('2026-07-21', 1, 2, 0.5, 1.5),
    candle('2026-07-22', 1.5, 2.2, 1.2, 2),
  ], 'H4');

  assert.ok(zones.every((zone) => Number.isFinite(zone.price)));
  assert.ok(zones.every((zone) => zone.timeframe === 'H4'));
});
