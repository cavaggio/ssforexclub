import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('extended Auto AI cron runs ICT, V3, and PPR sequentially for every enabled account', () => {
  const source = readFileSync(
    new URL('../app/api/cron/auto-ai-trading-extended/route.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /const AUTO_AI_ENGINES: readonly AutoAiEngine\[\] = \['ict', 'v3', 'ppr'\]/);
  assert.match(source, /function executionOrder\(preferredValue: unknown\): AutoAiEngine\[\]/);
  assert.match(source, /for \(const engine of executionOrder\(preferredEngine\)\)/);
  assert.match(source, /executionMode: 'all_engines_sequential'/);
  assert.match(source, /runId: `\$\{runId\}-\$\{engine\}`/);
  assert.doesNotMatch(
    source,
    /const engine = normalizeEngine\(row\.auto_ai_engine\);\s*const result = await callInternalEndpoint/s,
  );
});
