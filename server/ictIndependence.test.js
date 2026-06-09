import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// The ICT engine + executor must be fully independent of V3 — no V3 import, no
// evaluateV3 call, no V3 scoring module. (The display-only comparison lives in
// v3IctComparison.js, which is deliberately NOT in this list.)
const ICT_FILES = [
  'ictEngine.js', 'ictExecution.js', 'ictConcepts.js', 'ictSMT.js', 'ictTime.js',
  'ictLifecycleEngine.js', 'ictAutoTrade.js', 'ictAutoScheduler.js',
];

for (const f of ICT_FILES) {
  test(`ICT independence: ${f} does not depend on V3`, () => {
    const src = readFileSync(join(here, f), 'utf8');
    assert.ok(!/from\s+['"]\.\/v3Engine\.js['"]/.test(src), `${f} imports v3Engine.js`);
    assert.ok(!/from\s+['"]\.\/v3ExecutionModel\.js['"]/.test(src), `${f} imports v3ExecutionModel.js`);
    assert.ok(!/\bevaluateV3\s*\(/.test(src), `${f} calls evaluateV3()`);
    assert.ok(!/\bscoreV3\s*\(/.test(src), `${f} calls scoreV3()`);
  });
}
