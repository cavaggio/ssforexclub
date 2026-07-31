import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const runtimeSource = readFileSync(
  new URL('../scripts/runtime_execution_start.mjs', import.meta.url),
  'utf8',
);
const engineSource = readFileSync(new URL('./ictEngine.js', import.meta.url), 'utf8');

test('Railway startup recognizes the evolved ICT R:R contract before invoking the legacy patcher', () => {
  const guardIndex = runtimeSource.indexOf('if (hasIctRrRuntimeContract(before))');
  const patchCallIndex = runtimeSource.indexOf('applyIctRrFloorRuntime();');

  assert.ok(guardIndex >= 0, 'stable ICT R:R contract guard is missing');
  assert.ok(patchCallIndex > guardIndex, 'legacy patcher must run only after the stable contract guard');
  assert.match(runtimeSource, /const targetPolicy = enforceMinimumRRTarget\(\{/);
  assert.match(runtimeSource, /minimumRR: configuredIctMinRR\(\)/);
});

test('build-time adaptive stop metadata can coexist with the R:R contract', () => {
  assert.match(engineSource, /const targetPolicy = enforceMinimumRRTarget\(\{/);
  assert.match(engineSource, /riskModel: adaptiveStop/);
  assert.match(engineSource, /minimumRR: configuredIctMinRR\(\)/);
});

test('Railway startup enforces the authoritative 80% ICT confidence floor without restoring 93%', () => {
  assert.match(
    runtimeSource,
    /process\.env\.ICT_EXECUTION_MIN_CONFIDENCE = String\(Math\.max\(80,/,
  );
  assert.match(
    runtimeSource,
    /Math\.max\(80, parseFloat\(process\.env\.ICT_EXECUTION_MIN_CONFIDENCE \|\| '80'\)\)/,
  );
  assert.doesNotMatch(runtimeSource, /Math\.max\(93/);
  assert.doesNotMatch(runtimeSource, /process\.env\.ICT_MIN_CONFIDENCE/);
});
