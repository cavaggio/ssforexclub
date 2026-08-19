import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyIctH1Momentum } from './ictH1Momentum.js';

const candle = (open, close, hour, complete = true) => ({
  open,
  close,
  high: Math.max(open, close) + 0.0002,
  low: Math.min(open, close) - 0.0002,
  complete,
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

test('older bearish consolidation bodies do not veto a new bullish completed impulse', () => {
  const result = classifyIctH1Momentum({
    bias: 'bullish',
    h1Candles: [
      candle(1.1600, 1.1594, 10),
      candle(1.1594, 1.1590, 11),
      candle(1.1590, 1.1606, 12),
    ],
  });
  assert.equal(result.latestDirection, 'bullish');
  assert.equal(result.activeDirection, 'bullish');
  assert.equal(result.activeAligned, true);
  assert.equal(result.exhausted, false);
});

test('a strong live H1 candle can confirm the new impulse before older completed candles catch up', () => {
  const result = classifyIctH1Momentum({
    bias: 'bullish',
    h1Candles: [
      candle(1.1600, 1.1594, 10),
      candle(1.1594, 1.1590, 11),
      candle(1.1590, 1.1602, 12, false),
    ],
  });
  assert.equal(result.currentDirection, 'bullish');
  assert.equal(result.currentAligned, true);
  assert.equal(result.aligned, true);
  assert.equal(result.phase, 'live_impulse');
});

test('strong live H1 opposition vetoes continuation', () => {
  const result = classifyIctH1Momentum({
    bias: 'bullish',
    h1Candles: [
      candle(1.1580, 1.1590, 10),
      candle(1.1590, 1.1600, 11),
      candle(1.1600, 1.1588, 12, false),
    ],
  });
  assert.equal(result.currentOpposing, true);
  assert.equal(result.aligned, false);
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
