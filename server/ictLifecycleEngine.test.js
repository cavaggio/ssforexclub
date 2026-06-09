import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateHoldMinutes, reassessIctTrade } from './ictLifecycleEngine.js';

const NOW = new Date('2026-06-09T15:00:00Z');
const nowMs = NOW.getTime();
const base = { pair: 'EUR_USD', direction: 'long', entryPrice: 1.1000, candles: [], now: NOW, holdMinutes: 120 };

test('estimateHoldMinutes: by setup, with killzone nudge and default fallback', () => {
  assert.equal(estimateHoldMinutes('Silver Bullet'), 60);
  assert.equal(estimateHoldMinutes('MSS Reversal'), 180);
  assert.equal(estimateHoldMinutes('Unknown Setup'), 120); // ICT_HOLD_MINUTES_DEFAULT
  assert.ok(estimateHoldMinutes('OTE Continuation', { killzoneQuality: 50 }) < estimateHoldMinutes('OTE Continuation'));
});

test('lifecycle: within projected hold → always HOLD (no reassessment)', () => {
  const r = reassessIctTrade({ ...base, openedAtMs: nowMs - 60 * 60000 }); // 60m of a 120m hold
  assert.equal(r.pastHold, false);
  assert.equal(r.reassessDue, false);
  assert.equal(r.action, 'HOLD');
});

test('lifecycle: past hold + ~75% to target → PARTIAL_CLOSE', () => {
  const r = reassessIctTrade({ ...base, openedAtMs: nowMs - 130 * 60000, currentPrice: 1.1085, target1: 1.1100 });
  assert.equal(r.pastHold, true);
  assert.equal(r.reassessDue, true);
  assert.equal(r.action, 'PARTIAL_CLOSE'); // ~85% to target

});

test('lifecycle: past hold + ~50% to target → MOVE_BREAKEVEN', () => {
  const r = reassessIctTrade({ ...base, openedAtMs: nowMs - 130 * 60000, currentPrice: 1.1050, target1: 1.1100 });
  assert.equal(r.action, 'MOVE_BREAKEVEN');
});

test('lifecycle: past hold but inside 30-min cadence → HOLD', () => {
  const r = reassessIctTrade({ ...base, openedAtMs: nowMs - 130 * 60000, currentPrice: 1.1050, target1: 1.1100, lastReassessMs: nowMs - 10 * 60000 });
  assert.equal(r.pastHold, true);
  assert.equal(r.reassessDue, false);
  assert.equal(r.action, 'HOLD');
});

test('lifecycle: well past hold with no progress → TIGHTEN_STOP', () => {
  const r = reassessIctTrade({ ...base, openedAtMs: nowMs - 200 * 60000, currentPrice: 1.1001, target1: null });
  assert.equal(r.action, 'TIGHTEN_STOP');
});
