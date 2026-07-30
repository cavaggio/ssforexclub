import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyAccountEngineIsolation } from '../../scripts/apply_account_engine_isolation.mjs';
import { restoreV3WatchlistCompatibility } from '../../scripts/restore_v3_watchlist_compat.mjs';
import { prepareActualTradeLearningCompatibility } from '../../scripts/prepare_actual_trade_learning_compat.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PATCHED_FILES = [
  'web/app/api/cron/auto-ai-trading-extended/route.ts',
  'server/ictAutoTrade.js',
  'server/ictExecution.js',
  'server/v3IndependentScanner.js',
  'server/engineTradeLearning.js',
  'server/engineTradeLearningCore.js',
  'server/ictAutoScheduler.js',
];

test('Auto AI executes only the configured engine for each account while studies remain non-executing', () => {
  const root = mkdtempSync(join(tmpdir(), 'auto-ai-engine-isolation-'));
  try {
    for (const relative of PATCHED_FILES) {
      const destination = join(root, relative);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(resolve(ROOT, relative), destination);
    }

    prepareActualTradeLearningCompatibility(root);
    applyAccountEngineIsolation(root);
    restoreV3WatchlistCompatibility(root);

    const source = readFileSync(
      join(root, 'web/app/api/cron/auto-ai-trading-extended/route.ts'),
      'utf8',
    );

    assert.match(source, /const configuredEngine = normalizeEngine\(row\.auto_ai_engine\)/);
    assert.match(source, /: \[configuredEngine\]/);
    assert.match(source, /engineFilter === configuredEngine \? \[configuredEngine\] : \[\]/);
    assert.match(source, /engine_scope_mismatch/);
    assert.match(source, /for \(const selectedEngine of selectedEngines\)/);
    assert.match(source, /mode === 'daily_study'/);
    assert.match(source, /Daily market study requires engine ict or ppr/);
    assert.match(source, /executionMode: 'selected_engine_only'/);
    assert.match(source, /accountEngineIsolation=true/);
    assert.match(source, /engineWatchStates/);
    assert.match(source, /Targeted near\/hot rechecks require an engine/);
    assert.doesNotMatch(source, /executionMode: 'all_enabled_engines'/);
    assert.doesNotMatch(source, /allEnginesActive=true/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
