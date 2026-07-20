import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('generated ICT runtime treats active mode as executable', () => {
  const engine = readFileSync(new URL('./ictEngine.js', import.meta.url), 'utf8');
  const execution = readFileSync(new URL('./ictExecution.js', import.meta.url), 'utf8');

  assert.match(engine, /ICT_MODE === 'active'/);
  assert.match(engine, /\(c\.mode === 'active' \|\| c\.mode === 'live'\) && c\.autoTradeEnabled === true/);
  assert.match(execution, /config\.mode === 'active' \|\| config\.mode === 'live'/);
  assert.doesNotMatch(execution, /config\.mode === 'live' && config\.autoTradeEnabled/);
});
