import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyPriceBias,
  derivePrimaryTimeframes,
  directionFromDailyH4,
  V3_PRICE_BIAS_POLICY_VERSION,
} from './v3EntryContract.js';

function candles({ start = 1.1, step = 0, count = 40, range = 0.001, pattern = null } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const custom = typeof pattern === 'function' ? pattern(index) : 0;
    const open = start + (step * index) + custom;
    const close = open + (step * 0.6);
    return {
      time: new Date(Date.UTC(2026, 6, 1, index)).toISOString(),
      open,
      high: Math.max(open, close) + range / 2,
      low: Math.min(open, close) - range / 2,
      close,
      volume: 100,
    };
  });
}

test('native V3 price-bias policy is versioned', () => {
  assert.equal(V3_PRICE_BIAS_POLICY_VERSION, 'v3-price-action-trend-v2-2026-07-17');
});

test('persistent rising price action classifies bullish without legacy indicators', () => {
  const result = classifyPriceBias(candles({ step: 0.00018 }));
  assert.equal(result, 'bullish');
});

test('persistent falling price action classifies bearish without legacy indicators', () => {
  const result = classifyPriceBias(candles({ start: 1.2, step: -0.00018 }));
  assert.equal(result, 'bearish');
});

test('balanced alternating range remains neutral', () => {
  const result = classifyPriceBias(candles({
    range: 0.0012,
    pattern: (index) => (index % 2 === 0 ? 0.00025 : -0.00025),
  }));
  assert.equal(result, 'neutral');
});

test('shallow but persistent movement no longer collapses every timeframe to flat', () => {
  const daily = candles({ step: 0.00006, range: 0.0007 });
  const h4 = candles({ step: 0.000045, range: 0.0006 });
  const m15 = candles({ step: -0.00003, range: 0.0005 });
  const timeframes = derivePrimaryTimeframes({ dailyCandles: daily, h4Candles: h4, m15Candles: m15 });

  assert.equal(timeframes.daily, 'bullish');
  assert.equal(timeframes.h4, 'bullish');
  assert.equal(timeframes.m15, 'bearish');
  assert.equal(directionFromDailyH4(timeframes), 'long');
});

test('Daily and H4 disagreement still produces no executable direction', () => {
  const timeframes = derivePrimaryTimeframes({
    dailyCandles: candles({ step: 0.00012 }),
    h4Candles: candles({ start: 1.2, step: -0.00012 }),
    m15Candles: candles({ step: 0.00008 }),
  });
  assert.equal(directionFromDailyH4(timeframes), null);
});
