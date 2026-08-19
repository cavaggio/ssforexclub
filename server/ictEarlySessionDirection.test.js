import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyIctEarlySessionDirection } from './ictEarlySessionDirection.js';

const h1 = (time, open, close, complete = true) => ({
  time,
  open,
  close,
  high: Math.max(open, close) + 0.0002,
  low: Math.min(open, close) - 0.0002,
  complete,
});

test('classifies the fixed 01:00, 02:00 and 03:00 ET H1 candles as one session narrative', () => {
  const result = classifyIctEarlySessionDirection({
    now: new Date('2026-08-19T11:40:00Z'),
    bias: 'bullish',
    h1Candles: [
      h1('2026-08-19T04:00:00Z', 1.1570, 1.1568), // 00:00 ET, ignored
      h1('2026-08-19T05:00:00Z', 1.1568, 1.1573), // 01:00 ET bullish
      h1('2026-08-19T06:00:00Z', 1.1573, 1.1579), // 02:00 ET bullish
      h1('2026-08-19T07:00:00Z', 1.1579, 1.1587), // 03:00 ET bullish
      h1('2026-08-19T08:00:00Z', 1.1587, 1.1593), // 04:00 ET, ignored
    ],
  });

  assert.equal(result.availableCount, 3);
  assert.equal(result.completedCount, 3);
  assert.equal(result.direction, 'bullish');
  assert.equal(result.alignedWithBias, true);
  assert.equal(result.opposesBias, false);
  assert.equal(result.provisional, false);
  assert.deepEqual(result.samples.map((sample) => sample.hourEt), [1, 2, 3]);
});

test('does not mix the prior New York trading day into the fixed-hour profile', () => {
  const result = classifyIctEarlySessionDirection({
    now: new Date('2026-08-19T11:40:00Z'),
    bias: 'bullish',
    h1Candles: [
      h1('2026-08-18T05:00:00Z', 1.1600, 1.1590),
      h1('2026-08-19T05:00:00Z', 1.1570, 1.1575),
      h1('2026-08-19T06:00:00Z', 1.1575, 1.1580),
    ],
  });

  assert.equal(result.availableCount, 2);
  assert.equal(result.direction, 'bullish');
  assert.equal(result.alignedWithBias, true);
});

test('marks the profile provisional before two fixed candles have closed', () => {
  const result = classifyIctEarlySessionDirection({
    now: new Date('2026-08-19T06:30:00Z'), // 02:30 ET
    bias: 'bullish',
    h1Candles: [
      h1('2026-08-19T05:00:00Z', 1.1570, 1.1574, true),
      h1('2026-08-19T06:00:00Z', 1.1574, 1.1578, false),
    ],
  });

  assert.equal(result.availableCount, 2);
  assert.equal(result.completedCount, 1);
  assert.equal(result.provisional, true);
  assert.equal(result.direction, 'bullish');
});
