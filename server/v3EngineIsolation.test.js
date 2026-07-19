import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAutoForUser } from './autoAiRouter.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(root, relative));

const V3_STRATEGY_FILES = [
  'server/v3Engine.js',
  'server/v3IndependentScanner.js',
  'server/v3AutoTrade.js',
  'server/v3DashboardScan.js',
  'server/v3QualityConfirmation.js',
  'server/v3ExecutionModel.js',
];

test('V3 strategy graph has no ICT, PPR, or retired legacy dependencies', () => {
  const forbidden = [
    /from ['"]\.\/ict/i,
    /from ['"]\.\/ppr/i,
    /oandaScanner/,
    /tradeDecisionEngine/,
    /retraceWatchMode/,
    /legacyDirection/,
    /directionAgrees/,
  ];

  for (const relative of V3_STRATEGY_FILES) {
    const source = read(relative);
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${relative} violates V3 isolation with ${pattern}`);
    }
  }
});

test('retired legacy engine files are physically absent', () => {
  assert.equal(exists('server/oandaScanner.js'), false);
  assert.equal(exists('server/tradeDecisionEngine.js'), false);
  assert.equal(exists('server/v3IctComparison.js'), false);
});

test('server exposes no retired scanner or generic legacy trade route', () => {
  const index = read('server/index.js');
  assert.doesNotMatch(index, /from ['"]\.\/oandaScanner\.js['"]/);
  assert.doesNotMatch(index, /from ['"]\.\/v3IctComparison\.js['"]/);
  assert.doesNotMatch(index, /app\.get\('\/api\/oanda\/scan'/);
  assert.doesNotMatch(index, /app\.post\('\/api\/oanda\/trade'/);
  assert.doesNotMatch(index, /app\.post\('\/api\/internal\/oanda\/scan'/);
  assert.doesNotMatch(index, /app\.post\('\/api\/internal\/oanda\/trade'/);
  assert.doesNotMatch(index, /computeV3Comparisons\(/);
});

test('V3 route executes only the V3 runner', async () => {
  const calls = [];
  const result = await runAutoForUser({
    client: { accountId: 'isolation-test' },
    engine: 'v3',
    now: new Date('2026-07-20T13:00:00.000Z'),
    runIct: async () => { calls.push('ict'); return {}; },
    runV3: async () => { calls.push('v3'); return { scanned: 1 }; },
    runPpr: async () => { calls.push('ppr'); return {}; },
  });

  assert.deepEqual(calls, ['v3']);
  assert.equal(result.engine, 'v3');
  assert.equal(result.scanned, 1);
});

test('engine-neutral window replaces ICT scheduler dependency in router', () => {
  const router = read('server/autoAiRouter.js');
  assert.match(router, /from ['"]\.\/autoAiWindow\.js['"]/);
  assert.doesNotMatch(router, /from ['"]\.\/ictAutoScheduler\.js['"]/);
});

test('shared OANDA transport no longer imports the legacy decision policy', () => {
  const trade = read('server/oandaTrade.js');
  assert.doesNotMatch(trade, /tradeDecisionEngine|evaluateTradeCandidate/);
});
