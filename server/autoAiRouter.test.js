import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAutoEngine, runAutoForUser } from './autoAiRouter.js';

const INSIDE_ALL_EXECUTION_WINDOWS = new Date('2026-07-13T13:00:00Z'); // Monday 09:00 ET
const MORNING_STUDY_WINDOW = new Date('2026-07-13T06:05:00Z'); // Monday 02:05 ET
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

test('02:00–02:29 ET is reserved for market study, not normal live scanning', async () => {
  for (const engine of ENGINES) {
    const { calls, result } = await routeAt(engine, MORNING_STUDY_WINDOW);
    assert.deepEqual(calls, []);
    assert.equal(result.engine, engine);
    assert.equal(result.scanned, 0);
    assert.equal(result.executionAllowed, false);
    assert.match(result.skipped[0].reason, /outside_auto_ai_scan_window_02:30-10:30_ET/);
  }
});

test('V3, PPR, and ICT all begin live scan/execution at 02:30 ET', async () => {
  for (const engine of ENGINES) {
    const before = await routeAt(engine, new Date('2026-07-13T06:29:00Z'));
    const open = await routeAt(engine, new Date('2026-07-13T06:30:00Z'));
    assert.deepEqual(before.calls, []);
    assert.equal(before.result.executionAllowed, false);
    assert.deepEqual(open.calls.map((call) => call.engine), [engine]);
    assert.equal(open.calls[0].args.executionAllowed, true);
    assert.equal(open.result.executionAllowed, true);
  }
});

test('V3, PPR, and ICT remain open through 10:29 ET and close at 10:30 ET', async () => {
  for (const engine of ENGINES) {
    const lastMinute = await routeAt(engine, new Date('2026-07-13T14:29:00Z'));
    const closed = await routeAt(engine, new Date('2026-07-13T14:30:00Z'));
    assert.deepEqual(lastMinute.calls.map((call) => call.engine), [engine]);
    assert.equal(lastMinute.result.executionAllowed, true);
    assert.deepEqual(closed.calls, []);
    assert.equal(closed.result.executionAllowed, false);
    assert.match(closed.result.skipped[0].reason, /outside_auto_ai_scan_window_02:30-10:30_ET/);
  }
});

test('02:00 ET current-day study and 17:30 ET end-of-day study can never submit an order', async () => {
  for (const now of [
    new Date('2026-07-13T06:05:00Z'), // 02:05 ET morning study
    new Date('2026-07-13T21:35:00Z'), // 17:35 ET end-of-day review
  ]) {
    for (const engine of ['ict', 'ppr']) {
      const calls = [];
      const result = await runAutoForUser({
        client: { accountId: 'A', environment: 'live' },
        engine,
        now,
        scanMode: 'daily_study',
        ...runners(calls),
      });
      assert.deepEqual(calls.map((call) => call.engine), [engine]);
      assert.equal(calls[0].args.executionAllowed, false);
      assert.equal(calls[0].args.executionBlockedReason, 'daily_market_study_never_submits_orders');
      assert.equal(result.executionAllowed, false);
      assert.equal(result.qualificationAllowed, false);
    }
  }
});

test('routing: each internal call still runs exactly one engine', async () => {
  for (const engine of ENGINES) {
    const { calls } = await routeAt(engine, INSIDE_ALL_EXECUTION_WINDOWS);
    assert.equal(calls.length, 1, `engine ${engine} must call exactly one path`);
  }
});

test('routing: blocks normal scans before 02:30, at-or-after 10:30, and on weekends', async () => {
  for (const now of [
    new Date('2026-07-13T06:29:00Z'), // Monday 02:29 ET
    new Date('2026-07-13T14:30:00Z'), // Monday 10:30 ET
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
