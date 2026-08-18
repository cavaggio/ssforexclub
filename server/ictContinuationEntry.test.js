import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyIctM5ContinuationEntry,
  resolveIctEntryAuthorization,
} from './ictContinuationEntry.js';

function m5Candles({ close = 1.1014, complete = true } = {}) {
  const start = Date.parse('2026-08-14T06:00:00Z');
  return Array.from({ length: 25 }, (_, index) => {
    const base = 1.1000 + (index * 0.00002);
    return {
      time: new Date(start + (index * 5 * 60_000)).toISOString(),
      open: index === 24 ? 1.1007 : base,
      high: index === 24 ? Math.max(close, 1.1007) + 0.0001 : base + 0.00012,
      low: index === 24 ? Math.min(close, 1.1007) - 0.0001 : base - 0.00008,
      close: index === 24 ? close : base + 0.00002,
      complete: index === 24 ? complete : true,
    };
  });
}

function bullishBreakout(overrides = {}) {
  const candles = m5Candles();
  return classifyIctM5ContinuationEntry({
    candles,
    bias: 'bullish',
    h1Bias: 'bullish',
    h1Momentum: { aligned: true, activeAligned: true, activeDirection: 'bullish' },
    bos: {
      direction: 'bullish',
      brokenLevel: 1.1010,
      time: candles.at(-1).time,
    },
    displacement: {
      direction: 'bullish',
      candleIndex: candles.length - 1,
      createdFVG: true,
    },
    fvgs: [{ type: 'bullish', status: 'open' }],
    atrPrice: 0.0005,
    ...overrides,
  });
}

test('aligned H1 plus fresh M5 displacement BOS authorizes a continuation breakout', () => {
  const result = bullishBreakout();

  assert.equal(result.ready, true);
  assert.equal(result.mode, 'm5_continuation_breakout');
  assert.equal(result.bosAligned, true);
  assert.match(result.cycleId, /^bullish:m5_continuation_breakout:/);
});

test('H1 active momentum—not structural bias—must agree for the continuation path', () => {
  const result = bullishBreakout({
    h1Bias: 'bullish',
    h1Momentum: { aligned: false, activeAligned: false, exhausted: true, activeDirection: 'bearish', reason: 'H1 momentum reversed.' },
  });

  assert.equal(result.ready, false);
  assert.equal(result.status, 'h1_momentum_exhausted');
});

test('an extended breakout is rejected instead of chased', () => {
  const candles = m5Candles({ close: 1.1020 });
  const result = bullishBreakout({ candles, maxExtensionAtr: 1.25 });

  assert.equal(result.ready, false);
  assert.equal(result.status, 'breakout_overextended');
  assert.ok(result.extensionAtr > result.maxExtensionAtr);
});

test('a live M5 candle cannot authorize a continuation entry before close', () => {
  const candles = m5Candles({ complete: false });
  const result = bullishBreakout({ candles });

  assert.equal(result.ready, false);
  assert.equal(result.status, 'await_m5_close');
});

test('first held M5 retest uses the original break as a stable re-entry cycle id', () => {
  const candles = m5Candles({ close: 1.1011 });
  candles[21] = {
    ...candles[21],
    open: 1.1008,
    high: 1.1013,
    low: 1.1007,
    close: 1.1012,
  };
  const first = classifyIctM5ContinuationEntry({
    candles,
    bias: 'bullish',
    h1Bias: 'bullish',
    h1Momentum: { aligned: true, activeAligned: true },
    retest: { direction: 'bullish', retestLevel: 1.1010 },
    fvgs: [{ type: 'bullish', status: 'partial' }],
    atrPrice: 0.0005,
  });
  const nextCandles = [
    ...candles,
    {
      ...candles.at(-1),
      time: '2026-08-14T08:05:00.000Z',
      open: 1.1011,
      close: 1.10115,
      high: 1.1012,
      low: 1.1010,
    },
  ];
  const next = classifyIctM5ContinuationEntry({
    candles: nextCandles,
    bias: 'bullish',
    h1Bias: 'bullish',
    h1Momentum: { aligned: true, activeAligned: true },
    retest: { direction: 'bullish', retestLevel: 1.1010 },
    fvgs: [{ type: 'bullish', status: 'partial' }],
    atrPrice: 0.0005,
  });

  assert.equal(first.ready, true);
  assert.equal(first.mode, 'm5_continuation_retest');
  assert.equal(next.ready, true);
  assert.equal(first.cycleId, next.cycleId);
});

test('entry authorization falls back to M5 continuation when no fresh H1 transition exists', () => {
  const authorization = resolveIctEntryAuthorization({
    h1Transition: { ready: false, transitionId: null, reason: 'H1 transition window ended.' },
    continuationBreakout: bullishBreakout(),
  });

  assert.equal(authorization.ready, true);
  assert.equal(authorization.mode, 'm5_continuation_breakout');
});
