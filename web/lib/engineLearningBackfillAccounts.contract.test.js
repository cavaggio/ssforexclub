import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../app/api/cron/engine-learning-backfill/route.ts', import.meta.url),
  'utf8',
);

test('learning backfill processes every active OANDA account for enabled users', () => {
  assert.match(source, /listBrokerConnectionsForUser/);
  assert.match(source, /connection\.isActive && connection\.broker === 'oanda'/);
  assert.match(source, /for \(const account of activeAccounts\)/);
  assert.match(source, /accountsProcessed \+= 1/);
  assert.match(source, /brokerAccountId: account\.accountId/);
  assert.match(source, /connectionId: account\.id/);
  assert.match(source, /validationStatus: account\.validationStatus/);
  assert.doesNotMatch(source, /resolveActiveBrokerForUser/);
  assert.doesNotMatch(source, /getCredentials\(\)/);
});

test('learning remains engine-isolated within each account', () => {
  assert.match(source, /const ENGINES = \['ict', 'ppr', 'v3'\] as const/);
  assert.match(source, /for \(const engine of ENGINES as readonly Engine\[\]\)/);
  assert.match(source, /engine,/);
  assert.match(source, /configuredEngine: row\.auto_ai_engine \|\| null/);
});
