import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('generated ICT engine and executor both accept active mode', () => {
  const engine = readFileSync(new URL('./ictEngine.js', import.meta.url), 'utf8');
  const executor = readFileSync(new URL('./ictExecution.js', import.meta.url), 'utf8');

  assert.match(engine, /ICT_MODE === 'active'/);
  assert.match(engine, /c\.mode === 'active' \|\| c\.mode === 'live'/);
  assert.match(executor, /config\.mode === 'active' \|\| config\.mode === 'live'/);
});
