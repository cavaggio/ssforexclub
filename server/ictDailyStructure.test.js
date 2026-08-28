import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDailyStructure, ICT_DAILY_WINDOWS } from './ictDailyStructure.js';

function candle(open, close, i) {
  return {
    time: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    open,
    high: Math.max(open, close) + 0.0005,
    low: Math.min(open, close) - 0.0005,
    close,
    volume: 100,
    complete: true,
  };
}

test('Daily ICT windows are fixed to 5-7 active, 20 context, 1-3 recency', () => {
  assert.deepEqual(ICT_DAILY_WINDOWS, { ACTIVE_MIN: 5, ACTIVE_MAX: 7, CONTEXT: 20, RECENCY: 3 });
});

test('recent opposing Daily delivery can neutralize stale active bias', () => {
  const bullishContext = Array.from({ length: 20 }, (_, i) => candle(1 + i * 0.001, 1.0008 + i * 0.001, i));
  const recentBearish = [
    candle(1.020, 1.0190, 17),
    candle(1.0190, 1.0170, 18),
    candle(1.0170, 1.0140, 19),
  ];
  const read = computeDailyStructure({ dailyCandles: [...bullishContext.slice(0, 17), ...recentBearish], currentPrice: 1.014 });

  assert.equal(read.activeWindow.candles, 7);
  assert.equal(read.contextWindow.candles, 20);
  assert.equal(read.recencyWindow.candles, 3);
  assert.equal(read.recencyBias, 'bearish');
  assert.equal(read.invalidatedByRecency, true);
  assert.equal(read.dailyBias, 'neutral');
});

test('aligned active and recent Daily structure remains bullish', () => {
  const candles = Array.from({ length: 20 }, (_, i) => candle(1 + i * 0.001, 1.0008 + i * 0.001, i));
  const read = computeDailyStructure({ dailyCandles: candles, currentPrice: 1.0208 });

  assert.equal(read.dailyBias, 'bullish');
  assert.equal(read.activeBias, 'bullish');
  assert.equal(read.recencyBias, 'bullish');
});

test('fewer than five completed Daily candles cannot qualify active confirmation', () => {
  const candles = Array.from({ length: 4 }, (_, i) => candle(1 + i * 0.001, 1.0008 + i * 0.001, i));
  assert.equal(computeDailyStructure({ dailyCandles: candles }).qualified, false);
});
