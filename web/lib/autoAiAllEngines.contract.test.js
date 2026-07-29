import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Auto AI full scans execute every enabled engine while targeted rechecks remain engine-scoped', () => {
  const source = readFileSync(
    new URL('../app/api/cron/auto-ai-trading-extended/route.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /const configuredEngine = normalizeEngine\(row\.auto_ai_engine\)/);
  assert.match(source, /const selectedEngines: AutoAiEngine\[\]/);
  assert.match(source, /for \(const selectedEngine of selectedEngines\)/);
  assert.match(source, /mode === 'daily_study'/);
  assert.match(source, /Daily market study requires engine ict or ppr/);
  assert.match(source, /engine: selectedEngine/);
  assert.match(source, /executionMode: 'all_enabled_engines'/);
  assert.match(source, /engineWatchStates/);
  assert.match(source, /Targeted near\/hot rechecks require an engine/);
  assert.match(source, /allEnginesActive=true/);
  assert.doesNotMatch(source, /executionMode: 'selected_engine_only'/);
});
