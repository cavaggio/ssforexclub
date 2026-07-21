import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Auto AI cron runs exactly the engine selected for each enabled account', () => {
  const source = readFileSync(
    new URL('../app/api/cron/auto-ai-trading-extended/route.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /const selectedEngine = normalizeEngine\(row\.auto_ai_engine\)/);
  assert.match(source, /engine: selectedEngine/);
  assert.match(source, /executionMode: 'selected_engine_only'/);
  assert.match(source, /engineWatchStates/);
  assert.match(source, /Targeted near\/hot rechecks require an engine/);
  assert.doesNotMatch(source, /function executionOrder/);
  assert.doesNotMatch(source, /for \(const engine of executionOrder/);
  assert.doesNotMatch(source, /executionMode: 'all_engines_sequential'/);
});
