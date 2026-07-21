import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAutoEngine, runAutoForUser } from './autoAiRouter.js';

const INSIDE_EXECUTION_WINDOW = new Date('2026-07-13T13:00:00Z'); // Monday 09:00 ET
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

test('routing: each selection calls only its own engine after 02:15 ET', async () => {
  for (const engine of ENGINES) {
    const calls = [];
    const result = await runAutoForUser({
      client: { accountId: 'A', environment: 'live' },
      engine,
      now: INSIDE_EXECUTION_WINDOW,
      ...runners(calls),
    });
    assert.deepEqual(calls.map((call) => call.engine), [engine]);
    assert.equal(calls[0].args.executionAllowed, true);
    assert.equal(result.engine, engine);
    assert.equal(result.executionAllowed, true);
  }
});

test('routing: 02:00–02:14 scans only the selected engine and blocks order submission', async () => {
  for (const engine of ENGINES) {
    const calls = [];
    const result = await runAutoForUser({
      client: { accountId: 'A', environment: 'live' },
      engine,
      now: PRE_ENTRY_SCAN_WINDOW,
      ...runners(calls),
    });
    assert.deepEqual(calls.map((call) => call.engine), [engine]);
    assert.equal(calls[0].args.executionAllowed, false);
    assert.match(calls[0].args.executionBlockedReason, /02:15/);
    assert.equal(result.engine, engine);
    assert.equal(result.executionAllowed, false);
  }
});

test('routing: never runs more than one engine in one call', async () => {
  for (const engine of ENGINES) {
    const calls = [];
    await runAutoForUser({
      client: { accountId: 'A', environment: 'live' },
      engine,
      now: INSIDE_EXECUTION_WINDOW,
      ...runners(calls),
    });
    assert.equal(calls.length, 1, `engine ${engine} must call exactly one path`);
  }
});

test('routing: blocks all engines outside the 02:00–10:00 scan window and on weekends', async () => {
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
