import assert from 'node:assert/strict';
import { computeDailyStructure } from '../server/ictDailyStructure.js';

function candle(open, close, i) {
  const high = Math.max(open, close) + 0.0005;
  const low = Math.min(open, close) - 0.0005;
  return { time: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), open, high, low, close, volume: 100, complete: true };
}

const oldBullishContext = Array.from({ length: 20 }, (_, i) => candle(1 + i * 0.001, 1.0008 + i * 0.001, i));
const recentBearish = [
  candle(1.020, 1.0190, 17),
  candle(1.0190, 1.0170, 18),
  candle(1.0170, 1.0140, 19),
];
const mixed = [...oldBullishContext.slice(0, 17), ...recentBearish];
const read = computeDailyStructure({ dailyCandles: mixed, currentPrice: 1.014 });

assert.equal(read.activeWindow.candles, 7);
assert.equal(read.contextWindow.candles, 20);
assert.equal(read.recencyWindow.candles, 3);
assert.equal(read.recencyBias, 'bearish');
assert.equal(read.invalidatedByRecency, true);
assert.equal(read.dailyBias, 'neutral');

const bullishRecent = [
  candle(1.014, 1.016, 17),
  candle(1.016, 1.018, 18),
  candle(1.018, 1.021, 19),
];
const bullish = [...oldBullishContext.slice(0, 17), ...bullishRecent];
const bullishRead = computeDailyStructure({ dailyCandles: bullish, currentPrice: 1.021 });
assert.equal(bullishRead.dailyBias, 'bullish');
assert.equal(bullishRead.activeBias, 'bullish');
assert.equal(bullishRead.recencyBias, 'bullish');

assert.equal(computeDailyStructure({ dailyCandles: bullish.slice(-4) }).qualified, false);

console.log('Daily ICT hierarchy verification passed.');
