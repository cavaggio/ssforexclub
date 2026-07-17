import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAutoEngine, runAutoForUser } from './autoAiRouter.js';

const INSIDE_WINDOW = new Date('2026-07-13T13:00:00Z'); // Monday 09:00 ET

test('engine select: disabled toggle → null (nothing runs)', () => {
  assert.equal(resolveAutoEngine({ autoAiTradingEnabled: false, autoAiEngine: 'ict' }), null);
  assert.equal(resolveAutoEngine({ autoAiTradingEnabled: false, autoAiEngine: 'v3' }), null);
});

test('engine select: enabled → exactly one engine', () => {
  assert.equal(resolveAutoEngine({ autoAiTradingEnabled: true, autoAiEngine: 'ict' }), 'ict');
  assert.equal(resolveAutoEngine({ autoAiTradingEnabled: true, autoAiEngine: 'v3' }), 'v3');
});

test('engine select: missing/invalid engine defaults safely to ict; missing toggle → off', () => {
  assert.equal(resolveAutoEngine({ autoAiTradingEnabled: true }), 'ict');
  assert.equal(resolveAutoEngine({ autoAiTradingEnabled: true, autoAiEngine: 'nope' }), 'ict');
  assert.equal(resolveAutoEngine({}), null);
  assert.equal(resolveAutoEngine({ autoAiEngine: 'v3' }), null); // enabled missing → off
});

test('routing: ICT selected calls ONLY the ICT path inside execution window', async () => {
  const calls = [];
  const r = await runAutoForUser({
    client: { accountId: 'A', environment: 'live' }, engine: 'ict', now: INSIDE_WINDOW,
    runIct: async () => { calls.push('ict'); return { qualified: 0 }; },
    runV3: async () => { calls.push('v3'); return { qualified: 0 }; },
  });
  assert.deepEqual(calls, ['ict']);
  assert.equal(r.engine, 'ict');
});

test('routing: V3 selected calls ONLY the V3 path inside execution window', async () => {
  const calls = [];
  const r = await runAutoForUser({
    client: { accountId: 'A', environment: 'live' }, engine: 'v3', now: INSIDE_WINDOW,
    runIct: async () => { calls.push('ict'); return {}; },
    runV3: async () => { calls.push('v3'); return { qualified: 1 }; },
  });
  assert.deepEqual(calls, ['v3']);
  assert.equal(r.engine, 'v3');
});

test('routing: never runs both engines in one call', async () => {
  for (const engine of ['ict', 'v3']) {
    const calls = [];
    await runAutoForUser({
      client: { accountId: 'A', environment: 'live' }, engine, now: INSIDE_WINDOW,
      runIct: async () => { calls.push('ict'); return {}; },
      runV3: async () => { calls.push('v3'); return {}; },
    });
    assert.equal(calls.length, 1, `engine ${engine} must call exactly one path`);
  }
});

test('routing: blocks both engines at 10:00 ET and on weekends', async () => {
  for (const now of [
    new Date('2026-07-13T14:00:00Z'), // Monday 10:00 ET
    new Date('2026-07-18T13:00:00Z'), // Saturday 09:00 ET
  ]) {
    for (const engine of ['ict', 'v3']) {
      const calls = [];
      const r = await runAutoForUser({
        client: { accountId: 'A', environment: 'live' }, engine, now,
        runIct: async () => { calls.push('ict'); return {}; },
        runV3: async () => { calls.push('v3'); return {}; },
      });

      assert.deepEqual(calls, []);
      assert.equal(r.engine, engine);
      assert.equal(r.scanned, 0);
      assert.equal(r.executed.length, 0);
      assert.match(r.skipped[0].reason, /outside_auto_ai_execution_window/);
    }
  }
});
