import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getNewsRisk } from './news/forexFactoryNews.js';

const cfg = { enabled: true, blockBeforeMin: 30, blockAfterMin: 30 };
const calendar = [
  { currency: 'USD', impact: 'high',   event: 'Non-Farm Payrolls', time: '2026-06-05T12:30:00Z' },
  { currency: 'EUR', impact: 'medium', event: 'German ZEW',        time: '2026-06-05T12:35:00Z' },
];

test('high-impact news within window blocks the pair (either currency)', () => {
  const now = new Date('2026-06-05T12:40:00Z'); // +10m after NFP
  const r = getNewsRisk({ pair: 'EUR_USD', now, calendar, cfg });
  assert.equal(r.blocked, true);
  assert.equal(r.blockReason, 'High-impact news window active for USD: Non-Farm Payrolls');
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

test('disabled filter never blocks', () => {
  const now = new Date('2026-06-05T12:40:00Z');
  const r = getNewsRisk({ pair: 'EUR_USD', now, calendar, cfg: { ...cfg, enabled: false } });
  assert.equal(r.enabled, false);
  assert.equal(r.blocked, false);
});
