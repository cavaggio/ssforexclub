import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Auto AI executes only the configured engine for each account while studies remain non-executing', () => {
  const source = readFileSync(
    new URL('../app/api/cron/auto-ai-trading-extended/route.ts', import.meta.url),
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
});
