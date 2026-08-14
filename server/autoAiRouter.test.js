import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAutoEngine, runAutoForUser } from './autoAiRouter.js';

const INSIDE_ALL_EXECUTION_WINDOWS = new Date('2026-07-13T13:00:00Z'); // Monday 09:00 ET
const PRE_ENTRY_SCAN_WINDOW = new Date('2026-07-13T06:05:00Z'); // Monday 02:05 ET
const ENGINES = ['ict', 'v3', 'ppr'];

function runners(calls) {
  const make = (engine) => async (args) => {
    calls.push({ engine, args });
    return { qualified: 0, executed: [] };
  };
  return {
    runIct: make('ict'),
    runV3: make('v3'),
    runPpr: make('ppr'),
  };
}

async function routeAt(engine, now) {
  const calls = [];
  const result = await runAutoForUser({
    client: { accountId: 'A', environment: 'live' },
    engine,
    now,
    ...runners(calls),
  });
  return { calls, result };
}

test('engine select: disabled toggle → null (nothing runs)', () => {
  for (const engine of ENGINES) {
    assert.equal(resolveAutoEngine({ autoAiTradingEnabled: false, autoAiEngine: engine }), null);
  }
});

test('engine select: enabled preserves ICT, V3, and PPR', () => {
  for (const engine of ENGINES) {
    assert.equal(resolveAutoEngine({ autoAiTradingEnabled: true, autoAiEngine: engine }), engine);
  }
});

test('engine select: missing/invalid engine defaults safely to ICT; missing toggle → off', () => {
  assert.equal(resolveAutoEngine({ autoAiTradingEnabled: true }), 'ict');
  assert.equal(resolveAutoEngine({ autoAiTradingEnabled: true, autoAiEngine: 'nope' }), 'ict');
  assert.equal(resolveAutoEngine({}), null);
  assert.equal(resolveAutoEngine({ autoAiEngine: 'ppr' }), null);
});

test('routing: each selection calls only its own engine during its execution window', async () => {
  for (const engine of ENGINES) {
    const { calls, result } = await routeAt(engine, INSIDE_ALL_EXECUTION_WINDOWS);
    assert.deepEqual(calls.map((call) => call.engine), [engine]);
    assert.equal(calls[0].args.executionAllowed, true);
    assert.equal(result.engine, engine);
    assert.equal(result.executionAllowed, true);
  }
});

test('routing: all engines scan from 02:00 ET without submitting early orders', async () => {
  for (const engine of ENGINES) {
    const { calls, result } = await routeAt(engine, PRE_ENTRY_SCAN_WINDOW);
    assert.deepEqual(calls.map((call) => call.engine), [engine]);
    assert.equal(calls[0].args.executionAllowed, false);
    assert.equal(result.executionAllowed, false);
  }
});

test('V3, PPR, and ICT all begin execution at 02:30 ET', async () => {
  for (const engine of ENGINES) {
    const before = await routeAt(engine, new Date('2026-07-13T06:29:00Z'));
    const open = await routeAt(engine, new Date('2026-07-13T06:30:00Z'));
    assert.equal(before.result.executionAllowed, false);
    assert.match(before.calls[0].args.executionBlockedReason, /02:30/);
    assert.equal(open.result.executionAllowed, true);
  }
});

test('02:00 ET daily study can never submit an order', async () => {
  for (const engine of ['ict', 'ppr']) {
    const calls = [];
    const result = await runAutoForUser({
      client: { accountId: 'A', environment: 'live' },
      engine,
      now: new Date('2026-07-13T06:05:00Z'),
      scanMode: 'daily_study',
      ...runners(calls),
    });
    assert.deepEqual(calls.map((call) => call.engine), [engine]);
    assert.equal(calls[0].args.executionAllowed, false);
    assert.equal(calls[0].args.executionBlockedReason, 'daily_market_study_never_submits_orders');
    assert.equal(result.executionAllowed, false);
  }
});

test('routing: each internal call still runs exactly one engine', async () => {
  for (const engine of ENGINES) {
    const { calls } = await routeAt(engine, INSIDE_ALL_EXECUTION_WINDOWS);
    assert.equal(calls.length, 1, `engine ${engine} must call exactly one path`);
  }
});

test('routing: blocks normal scans outside the 02:00–10:00 window and on weekends', async () => {
  for (const now of [
    new Date('2026-07-13T14:00:00Z'), // Monday 10:00 ET
    new Date('2026-07-18T13:00:00Z'), // Saturday 09:00 ET
  ]) {
    for (const engine of ENGINES) {
      const calls = [];
      const result = await runAutoForUser({
        client: { accountId: 'A', environment: 'live' },
        engine,
        now,
        ...runners(calls),
      });
      assert.deepEqual(calls, []);
      assert.equal(result.engine, engine);
      assert.equal(result.scanned, 0);
      assert.equal(result.executed.length, 0);
      assert.match(result.skipped[0].reason, /outside_auto_ai_scan_window/);
    }
  }
});
