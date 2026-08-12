import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyIctHourlyEntryTransition } from './ictHourlyEntry.js';

const candle = ({ time, open, close, complete = true }) => ({
  time,
  open,
  close,
  high: Math.max(open, close) + 0.0002,
  low: Math.min(open, close) - 0.0002,
  complete,
});

test('bullish ICT entry is authorized only at the fresh H1 countertrend-to-bias transition', () => {
  const result = classifyIctHourlyEntryTransition({
    bias: 'bullish',
    now: new Date('2026-08-12T12:08:00Z'),
    h1Candles: [
      candle({ time: '2026-08-12T11:00:00Z', open: 1.1020, close: 1.1000 }),
      candle({ time: '2026-08-12T12:00:00Z', open: 1.1000, close: 1.1003, complete: false }),
    ],
  });

  assert.equal(result.ready, true);
  assert.equal(result.previousDirection, 'bearish');
  assert.equal(result.currentDirection, 'bullish');
  assert.equal(result.transitionId, 'bullish:2026-08-12T12:00:00Z');
});

test('a supporting H1 candle is rejected after the entry window ends', () => {
  const result = classifyIctHourlyEntryTransition({
    bias: 'bullish',
    now: new Date('2026-08-12T12:31:00Z'),
    h1Candles: [
      candle({ time: '2026-08-12T11:00:00Z', open: 1.1020, close: 1.1000 }),
      candle({ time: '2026-08-12T12:00:00Z', open: 1.1000, close: 1.1003, complete: false }),
    ],
  });

  assert.equal(result.ready, false);
  assert.equal(result.status, 'late_hourly_entry');
  assert.match(result.reason, /transition window has ended/i);
});

test('a closed H1 candle cannot be mistaken for the live entry candle', () => {
  const result = classifyIctHourlyEntryTransition({
    bias: 'bearish',
    now: new Date('2026-08-12T12:08:00Z'),
    h1Candles: [
      candle({ time: '2026-08-12T11:00:00Z', open: 1.1000, close: 1.1020 }),
      candle({ time: '2026-08-12T12:00:00Z', open: 1.1020, close: 1.1017 }),
    ],
  });

  assert.equal(result.ready, false);
  assert.equal(result.status, 'await_live_h1');
});

test('an already-expanded live H1 body is rejected as consumed momentum', () => {
  const result = classifyIctHourlyEntryTransition({
    bias: 'bearish',
    now: new Date('2026-08-12T12:08:00Z'),
    maxRangeFraction: 0.35,
    h1Candles: [
      candle({ time: '2026-08-12T11:00:00Z', open: 1.1000, close: 1.1010 }),
      candle({ time: '2026-08-12T12:00:00Z', open: 1.1010, close: 1.1002, complete: false }),
    ],
  });

  assert.equal(result.ready, false);
  assert.equal(result.status, 'hourly_momentum_consumed');
});
