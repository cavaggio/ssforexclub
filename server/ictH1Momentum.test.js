import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyIctH1Momentum } from './ictH1Momentum.js';

const candle = (open, close, hour) => ({
  open,
  close,
  high: Math.max(open, close) + 0.0002,
  low: Math.min(open, close) - 0.0002,
  complete: true,
  time: `2026-08-17T${String(hour).padStart(2, '0')}:00:00.000Z`,
});

test('bullish structure cannot authorize a long continuation after H1 momentum rotates bearish', () => {
  const result = classifyIctH1Momentum({
    bias: 'bullish',
    h1Candles: [
      candle(1.1600, 1.1590, 10),
      candle(1.1590, 1.1582, 11),
      candle(1.1582, 1.1575, 12),
    ],
  });
  assert.equal(result.aligned, false);
  assert.equal(result.activeDirection, 'bearish');
  assert.equal(result.exhausted, true);
});

test('strong bullish H1 momentum rejects a short continuation despite a bearish structural label', () => {
  const result = classifyIctH1Momentum({
    bias: 'bearish',
    h1Candles: [
      candle(159.00, 159.18, 10),
      candle(159.18, 159.34, 11),
      candle(159.34, 159.50, 12),
    ],
  });
  assert.equal(result.aligned, false);
  assert.equal(result.activeDirection, 'bullish');
  assert.equal(result.exhausted, true);
});

test('a fresh live H1 transition can authorize before completed-candle momentum catches up', () => {
  const result = classifyIctH1Momentum({
    bias: 'bullish',
    h1Candles: [candle(1.1600, 1.1590, 10), candle(1.1590, 1.1580, 11)],
    transition: { ready: true, bias: 'bullish' },
  });
  assert.equal(result.aligned, true);
  assert.equal(result.transitionAligned, true);
  assert.equal(result.phase, 'transition');
});
