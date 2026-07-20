import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  clearPairTradeCooldowns,
  isPairTradeCooldownActive,
  markPairTradeCooldown,
} from './oandaTrade.js';

test('cooldown is scoped to a pair so distinct qualified pairs can execute in one scan', () => {
  clearPairTradeCooldowns();
  const now = Date.now();
  markPairTradeCooldown('EUR_GBP', now);
  assert.equal(isPairTradeCooldownActive('EUR_GBP', now + 1_000), true);
  assert.equal(isPairTradeCooldownActive('GBP_USD', now + 1_000), false);
  clearPairTradeCooldowns();
});

test('PPR dashboard scan route immediately attempts every qualified signal when Auto AI is enabled', () => {
  const indexSource = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.match(indexSource, /const autoExecute = req\.body\?\.autoExecute === true/);
  assert.match(indexSource, /for \(const signal of qualified\)/);
  assert.match(indexSource, /executePprTrade\(signal/);
  assert.match(indexSource, /allQualifiedAttempted/);
});

test('authenticated dashboard forwards Auto AI execution intent and preserves results', () => {
  const routeSource = readFileSync(
    new URL('../web/app/api/scanner/scan/route.ts', import.meta.url),
    'utf8',
  );
  assert.match(routeSource, /autoAiTradingEnabled && selectedEngine === 'ppr'/);
  assert.match(routeSource, /autoExecute,/);
  assert.match(routeSource, /execution = rawScan\.execution/);
  assert.match(routeSource, /attempted=\$\{execution\?\.attempted/);
});
