import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Auto AI trading stays selected-engine-only while daily studies can target ICT or PPR', () => {
  const source = readFileSync(
    new URL('../app/api/cron/auto-ai-trading-extended/route.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /const configuredEngine = normalizeEngine\(row\.auto_ai_engine\)/);
  assert.match(source, /const selectedEngine = scanMode === 'daily_study' && engineFilter/);
  assert.match(source, /if \(scanMode !== 'daily_study' && engineFilter && configuredEngine !== engineFilter\) continue/);
  assert.match(source, /mode === 'daily_study'/);
  assert.match(source, /Daily market study requires engine ict or ppr/);
  assert.match(source, /engine: selectedEngine/);
  assert.match(source, /executionMode: 'selected_engine_only'/);
  assert.match(source, /engineWatchStates/);
  assert.match(source, /Targeted near\/hot rechecks require an engine/);
  assert.doesNotMatch(source, /function executionOrder/);
  assert.doesNotMatch(source, /for \(const engine of executionOrder/);
  assert.doesNotMatch(source, /executionMode: 'all_engines_sequential'/);
});
