import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getNewsRisk, __resetCalendarCache } from './news/forexFactoryNews.js';

const cfg = { enabled: true, blockBeforeMin: 30, blockAfterMin: 30 };
const calendar = [
  { currency: 'USD', impact: 'high',   event: 'Non-Farm Payrolls', time: '2026-06-05T12:30:00Z' },
  { currency: 'EUR', impact: 'medium', event: 'German ZEW',        time: '2026-06-05T12:35:00Z' },
];

test('high-impact news within window blocks the pair (either currency)', () => {
  const now = new Date('2026-06-05T12:40:00Z'); // +10m after NFP
  const r = getNewsRisk({ pair: 'EUR_USD', now, calendar, cfg });
  assert.equal(r.blocked, true);
  assert.match(r.blockReason, /RED\/HIGH news blackout active for USD: Non-Farm Payrolls/);
});

test('medium-impact news adds caution only (no block)', () => {
  const now = new Date('2026-06-05T12:40:00Z');
  const r = getNewsRisk({ pair: 'EUR_GBP', now, calendar, cfg }); // only EUR medium applies
  assert.equal(r.blocked, false);
  assert.equal(r.caution, true);
  assert.match(r.cautionReason, /Medium-impact/);
});

test('outside the window there is no block or caution', () => {
  const now = new Date('2026-06-05T18:00:00Z'); // hours after the events
  const r = getNewsRisk({ pair: 'EUR_USD', now, calendar, cfg });
  assert.equal(r.blocked, false);
  assert.equal(r.caution, false);
});

test('pair currency filter — USD event does not affect a non-USD pair', () => {
  const now = new Date('2026-06-05T12:40:00Z');
  const r = getNewsRisk({ pair: 'GBP_CAD', now, calendar, cfg });
  assert.equal(r.blocked, false);
});

test('no red-folder events means normal trading', () => {
  const now = new Date('2026-06-05T12:40:00Z');
  const r = getNewsRisk({ pair: 'EUR_USD', now, calendar: [], cfg });
  assert.equal(r.blocked, false);
  assert.equal(r.feedUnavailable, false);
  assert.equal(r.caution, false);
});

test('feed outage with no cached events does not create a blanket trade blocker', () => {
  __resetCalendarCache();
  const now = new Date('2026-06-05T12:40:00Z');
  const r = getNewsRisk({ pair: 'EUR_USD', now });
  assert.equal(r.blocked, false);
  assert.equal(r.feedUnavailable, true);
});

test('disabled filter never blocks', () => {
  const now = new Date('2026-06-05T12:40:00Z');
  const r = getNewsRisk({ pair: 'EUR_USD', now, calendar, cfg: { ...cfg, enabled: false } });
  assert.equal(r.enabled, false);
  assert.equal(r.blocked, false);
});
