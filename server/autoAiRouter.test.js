import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAutoEngine, runAutoForUser } from './autoAiRouter.js';

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

test('routing: ICT selected calls ONLY the ICT path', async () => {
  const calls = [];
  const r = await runAutoForUser({
    client: { accountId: 'A', environment: 'live' }, engine: 'ict',
    runIct: async () => { calls.push('ict'); return { qualified: 0 }; },
    runV3: async () => { calls.push('v3'); return { qualified: 0 }; },
  });
  assert.deepEqual(calls, ['ict']);
  assert.equal(r.engine, 'ict');
});

test('routing: V3 selected calls ONLY the V3 path', async () => {
  const calls = [];
  const r = await runAutoForUser({
    client: { accountId: 'A', environment: 'live' }, engine: 'v3',
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
      client: { accountId: 'A', environment: 'live' }, engine,
      runIct: async () => { calls.push('ict'); return {}; },
      runV3: async () => { calls.push('v3'); return {}; },
    });
    assert.equal(calls.length, 1, `engine ${engine} must call exactly one path`);
  }
});
