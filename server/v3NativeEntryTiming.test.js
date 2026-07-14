import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyV3NativeEntryTiming,
  detectV3NativeRetest,
} from './v3NativeEntryTiming.js';

const fib = {
  entryZoneStatus: 'breakout_confirmed',
  reason: 'Breakout confirmed',
  swingLow: 1.0900,
  swingHigh: 1.1000,
  timeframeUsed: 'H1',
};

const v3 = {
  structure: {
    bosDetected: true,
    bos: { direction: 'bullish' },
    chochDetected: false,
  },
  liquidity: { liquiditySweepDetected: false },
};

const newsRisk = { blocked: false, riskLevel: 'low' };

test('breakout with no M15 retest is classified wait_for_retest', () => {
  const candles = [
    { high: 1.1030, low: 1.1010, close: 1.1020 },
    { high: 1.1040, low: 1.1015, close: 1.1030 },
  ];

  const result = classifyV3NativeEntryTiming({
    direction: 'long',
    fibonacci: fib,
    v3,
    m15Candles: candles,
    atrPips: 8,
    newsRisk,
    currentPrice: 1.1030,
    pair: 'EUR_USD',
  });

  assert.equal(result.status, 'wait_for_retest');
  assert.equal(result.retestDetected, false);
});

test('the breakout candle cannot be treated as its own retest', () => {
  const candles = [
    { high: 1.0998, low: 1.0985, close: 1.0992 },
    { high: 1.1020, low: 1.0997, close: 1.1015 },
  ];

  const retest = detectV3NativeRetest({
    direction: 'long',
    fibonacci: fib,
    m15Candles: candles,
    atrPips: 8,
    pair: 'EUR_USD',
  });

  assert.equal(retest, null);
});

test('M15 touch and hold after the breakout confirms a long retest', () => {
  const candles = [
    { high: 1.0998, low: 1.0985, close: 1.0992 },
    { high: 1.1030, low: 1.1005, close: 1.1020 },
    { high: 1.1012, low: 1.0998, close: 1.1005 },
  ];

  const retest = detectV3NativeRetest({
    direction: 'long',
    fibonacci: fib,
    m15Candles: candles,
    atrPips: 8,
    pair: 'EUR_USD',
  });
  assert.equal(retest?.type, 'retest');
  assert.ok((retest?.breakoutIndexFromLatest ?? 0) > (retest?.candleIndexFromLatest ?? 0));

  const result = classifyV3NativeEntryTiming({
    direction: 'long',
    fibonacci: fib,
    v3,
    m15Candles: candles,
    atrPips: 8,
    newsRisk,
    currentPrice: 1.1005,
    pair: 'EUR_USD',
  });

  assert.equal(result.status, 'valid_entry');
  assert.equal(result.retestDetected, true);
});

test('M15 touch that closes through the level does not confirm the retest', () => {
  const candles = [
    { high: 1.0998, low: 1.0985, close: 1.0992 },
    { high: 1.1030, low: 1.1005, close: 1.1020 },
    { high: 1.1005, low: 1.0985, close: 1.0990 },
  ];
  const result = detectV3NativeRetest({
    direction: 'long',
    fibonacci: fib,
    m15Candles: candles,
    atrPips: 8,
    pair: 'EUR_USD',
  });
  assert.equal(result, null);
});
