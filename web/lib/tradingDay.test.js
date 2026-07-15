import test from 'node:test';
import assert from 'node:assert/strict';

import { isSameNewYorkTradingDay, newYorkDateKey } from './tradingDay.js';

test('New York date key follows Eastern Time across UTC midnight', () => {
  assert.equal(newYorkDateKey('2026-07-15T03:30:00.000Z'), '2026-07-14');
  assert.equal(newYorkDateKey('2026-07-15T04:30:00.000Z'), '2026-07-15');
});

test('same trading day compares timestamps in New York', () => {
  const now = new Date('2026-07-15T12:00:00.000Z');
  assert.equal(isSameNewYorkTradingDay('2026-07-15T05:00:00.000Z', now), true);
  assert.equal(isSameNewYorkTradingDay('2026-07-15T03:59:59.000Z', now), false);
});

test('invalid values fail closed', () => {
  assert.equal(newYorkDateKey('not-a-date'), null);
  assert.equal(isSameNewYorkTradingDay('not-a-date'), false);
});
