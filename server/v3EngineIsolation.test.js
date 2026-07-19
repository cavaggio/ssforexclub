import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAutoForUser } from './autoAiRouter.js';
import { validateV3ExecutionSignal } from './v3TradeExecution.js';

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
  'server/v3TradeExecution.js',
  'server/v3ActiveTradeMonitor.js',
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
  const window = read('server/autoAiWindow.js');
  assert.match(router, /from ['"]\.\/autoAiWindow\.js['"]/);
  assert.doesNotMatch(router, /from ['"]\.\/ictAutoScheduler\.js['"]/);
  assert.doesNotMatch(window, /from ['"]\.\/(ict|ppr|v3)/i);
});

test('V3 execution contract rejects foreign strategy payloads', () => {
  const base = {
    engine: 'v3',
    architecture: 'independent_v3_raw_market_data',
    selectedLogicType: 'v3_pure',
    direction: 'long',
    v3: { engine: 'v3' },
    qualityConfirmation: {
      stage1: { allowed: true },
      stage2: { allowed: true, metrics: { lockedDirection: 'long', direction: 'long' } },
    },
    directionLock: { confirmedDirection: 'long', freshDirection: 'long' },
  };

  assert.equal(validateV3ExecutionSignal(base).allowed, true);
  const contaminated = validateV3ExecutionSignal({ ...base, ictSignalId: 'foreign-id' });
  assert.equal(contaminated.allowed, false);
  assert.match(contaminated.reasons.join(' '), /ictSignalId/);
});

test('V3 auto runner cannot call the shared executor directly', () => {
  const auto = read('server/v3AutoTrade.js');
  assert.match(auto, /from ['"]\.\/v3TradeExecution\.js['"]/);
  assert.match(auto, /executeV3Trade\(signal/);
  assert.doesNotMatch(auto, /from ['"]\.\/oandaTrade\.js['"]/);
  assert.doesNotMatch(auto, /executeTrade\(signal/);
});

test('V3 open positions dispatch before foreign post-entry analysis', () => {
  const monitor = read('server/oandaActiveTradeMonitor.js');
  const reassessor = read('server/oandaActiveTradeReassessor.js');
  assert.ok(monitor.indexOf('return analyzeV3OpenTrade(') < monitor.indexOf('analyzeMacro('));
  assert.ok(reassessor.indexOf('return reassessV3OpenTrade(') < reassessor.indexOf('analyzeMacro('));
});

test('shared OANDA transport no longer imports the legacy decision policy', () => {
  const trade = read('server/oandaTrade.js');
  assert.doesNotMatch(trade, /tradeDecisionEngine|evaluateTradeCandidate/);
});
