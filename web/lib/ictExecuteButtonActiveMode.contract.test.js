import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('qualified ICT execution route remains practice-capable and targets native ICT execution', () => {
  const route = readFileSync(new URL('../app/api/scanner/execute-qualified/route.ts', import.meta.url), 'utf8');
  assert.match(route, /internalPath: '\/api\/internal\/oanda\/ict\/trade'/);
  assert.match(route, /requireLive: false/);
});
