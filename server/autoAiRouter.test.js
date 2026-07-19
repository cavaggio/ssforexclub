import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAutoEngine, runAutoForUser } from './autoAiRouter.js';
import { DEFAULT_ICT_WATCHLIST } from './ictWatchlist.js';

const INSIDE_WINDOW = new Date('2026-07-13T13:00:00Z'); // Monday 09:00 ET
const ENGINES = ['ict', 'v3', 'ppr'];

function runners(calls) {
  return {
    runIct: async () => { calls.push('ict'); return { qualified: 0 }; },
    runV3: async () => { calls.push('v3'); return { qualified: 0 }; },
    runPpr: async () => { calls.push('ppr'); return { qualified: 0 }; },
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

test('routing: each selection calls only its own engine inside execution window', async () => {
  for (const engine of ENGINES) {
    const calls = [];
    const result = await runAutoForUser({
      client: { accountId: 'A', environment: 'live' },
      engine,
      now: INSIDE_WINDOW,
      ...runners(calls),
    });
    assert.deepEqual(calls, [engine]);
    assert.equal(result.engine, engine);
  }
});

test('routing: never runs more than one engine in one call', async () => {
  for (const engine of ENGINES) {
    const calls = [];
    await runAutoForUser({
      client: { accountId: 'A', environment: 'live' },
      engine,
      now: INSIDE_WINDOW,
      ...runners(calls),
    });
    assert.equal(calls.length, 1, `engine ${engine} must call exactly one path`);
  }
});

test('ICT full scan always receives the 12 required core pairs', async () => {
  const previousIctPairs = process.env.ICT_PAIRS;
  const previousForexWatchlist = process.env.FOREX_WATCHLIST;
  process.env.ICT_PAIRS = 'EUR_USD,USD_CAD'; // stale eight-pair-era style override
  delete process.env.FOREX_WATCHLIST;

  try {
    let received = null;
    await runAutoForUser({
      client: { accountId: 'A', environment: 'live' },
      engine: 'ict',
      now: INSIDE_WINDOW,
      runIct: async (args) => { received = args; return { qualified: 0 }; },
    });

    assert.deepEqual(received?.pairs, [...DEFAULT_ICT_WATCHLIST]);
    assert.equal(received?.pairs.length, 12);
  } finally {
    if (previousIctPairs === undefined) delete process.env.ICT_PAIRS;
    else process.env.ICT_PAIRS = previousIctPairs;
    if (previousForexWatchlist === undefined) delete process.env.FOREX_WATCHLIST;
    else process.env.FOREX_WATCHLIST = previousForexWatchlist;
  }
});

test('ICT near/hot rechecks preserve the explicit pair subset', async () => {
  let received = null;
  await runAutoForUser({
    client: { accountId: 'A', environment: 'live' },
    engine: 'ict',
    now: INSIDE_WINDOW,
    scanMode: 'hot_watch',
    pairs: ['GBP_JPY'],
    runIct: async (args) => { received = args; return { qualified: 0 }; },
  });
  assert.deepEqual(received?.pairs, ['GBP_JPY']);
});

test('routing: blocks all engines at 10:00 ET and on weekends', async () => {
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
      assert.match(result.skipped[0].reason, /outside_auto_ai_execution_window/);
    }
  }
});
