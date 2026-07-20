import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('qualified ICT button uses the native practice-capable route', () => {
  const source = readFileSync(new URL('../app/api/scanner/execute-qualified/route.ts', import.meta.url), 'utf8');
  const section = source.split("if (engine === 'ict')")[1].split("const direction = normalizeDirection(signal);")[0];
  assert.match(section, /internalPath: '\/api\/internal\/oanda\/ict\/trade'/);
  assert.match(section, /requireLive: false/);
});
