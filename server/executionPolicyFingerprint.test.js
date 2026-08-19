import test from 'node:test';
import assert from 'node:assert/strict';
import { setupFingerprint } from './executionPolicy.js';

function ictSignal({ triggerTime, cycleId }) {
  return {
    pair: 'GBP_USD',
    direction: 'long',
    session: 'New York AM',
    entryCandle: {
      time: triggerTime,
      triggerReady: true,
      triggerAgeBars: 0,
    },
    entryAuthorization: {
      ready: true,
      cycleId,
    },
  };
}

test('ICT setup fingerprint stays stable for the same M5 trigger and entry cycle', () => {
  const signal = ictSignal({
    triggerTime: '2026-08-19T14:45:00.000Z',
    cycleId: 'GBP_USD:continuation:2026-08-19T14:45:00.000Z',
  });

  assert.equal(
    setupFingerprint(signal, 'account-1'),
    setupFingerprint(structuredClone(signal), 'account-1'),
  );
});

test('ICT setup fingerprint rotates for a genuinely fresh M5 trigger', () => {
  const prior = setupFingerprint(
    ictSignal({
      triggerTime: '2026-08-19T14:45:00.000Z',
      cycleId: 'GBP_USD:continuation:2026-08-19T14:45:00.000Z',
    }),
    'account-1',
  );
  const fresh = setupFingerprint(
    ictSignal({
      triggerTime: '2026-08-19T14:50:00.000Z',
      cycleId: 'GBP_USD:continuation:2026-08-19T14:50:00.000Z',
    }),
    'account-1',
  );

  assert.notEqual(fresh, prior);
  assert.match(fresh, /2026-08-19T14:50:00\.000Z/);
});

test('ICT setup fingerprint rotates when the authorized entry cycle changes', () => {
  const triggerTime = '2026-08-19T14:50:00.000Z';
  const prior = setupFingerprint(
    ictSignal({ triggerTime, cycleId: 'cycle-a' }),
    'account-1',
  );
  const next = setupFingerprint(
    ictSignal({ triggerTime, cycleId: 'cycle-b' }),
    'account-1',
  );

  assert.notEqual(next, prior);
});
