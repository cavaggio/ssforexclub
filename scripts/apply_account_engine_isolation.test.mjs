import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyAccountEngineIsolation } from './apply_account_engine_isolation.mjs';
import { restoreV3WatchlistCompatibility } from './restore_v3_watchlist_compat.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PATCHED_FILES = [
  'web/app/api/cron/auto-ai-trading-extended/route.ts',
  'server/ictAutoTrade.js',
  'server/ictExecution.js',
  'server/v3IndependentScanner.js',
  'server/engineTradeLearning.js',
  'server/engineTradeLearningCore.js',
  'server/ictAutoScheduler.js',
];

function source(path) {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

test('generated runtime routes enforce one configured engine per account', () => {
  const route = source('web/app/api/cron/auto-ai-trading-extended/route.ts');
  assert.match(route, /engineFilter === configuredEngine \? \[configuredEngine\] : \[\]/);
  assert.match(route, /executionMode: 'selected_engine_only'/);
  assert.match(route, /engine_scope_mismatch/);
  assert.doesNotMatch(route, /executionMode: 'all_enabled_engines'/);
});

test('ICT scan and execution paths enforce the immutable four-pair watchlist', () => {
  const watchlist = source('server/ictWatchlist.js');
  const auto = source('server/ictAutoTrade.js');
  const execution = source('server/ictExecution.js');

  for (const pair of ['EUR_USD', 'GBP_USD', 'USD_JPY', 'GBP_JPY']) {
    assert.match(watchlist, new RegExp(`'${pair}'`));
  }
  assert.match(auto, /configuredIctWatchlist/);
  assert.match(auto, /requestedPairs\.filter\(\(pair\) => allowedPairs\.has\(pair\)\)/);
  assert.match(execution, /ICT hard watchlist rejected/);
});

test('V3 source remains compatible with the existing generated-source pipeline', () => {
  const sourceText = source('server/v3IndependentScanner.js');
  assert.match(sourceText, /const DEFAULT_V3_WATCHLIST = \[/);
  assert.match(sourceText, /function configuredWatchlist\(\)/);
  assert.match(sourceText, /process\.env\.FOREX_V3_WATCHLIST/);
  assert.doesNotMatch(sourceText, /configuredV3Watchlist/);
});

test('account engine isolation plus V3 compatibility restoration is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'account-engine-isolation-'));
  for (const relative of PATCHED_FILES) {
    const destination = join(root, relative);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(resolve(ROOT, relative), destination);
  }

  applyAccountEngineIsolation(root);
  restoreV3WatchlistCompatibility(root);
  const first = Object.fromEntries(PATCHED_FILES.map((relative) => [relative, readFileSync(join(root, relative), 'utf8')]));
  applyAccountEngineIsolation(root);
  restoreV3WatchlistCompatibility(root);
  const second = Object.fromEntries(PATCHED_FILES.map((relative) => [relative, readFileSync(join(root, relative), 'utf8')]));
  assert.deepEqual(second, first);
});
