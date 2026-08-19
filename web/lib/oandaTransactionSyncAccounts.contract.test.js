import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../app/api/cron/oanda-transaction-sync/route.ts', import.meta.url),
  'utf8',
);
const reconciliationSource = readFileSync(
  new URL('./tradeActivityReconciliation.ts', import.meta.url),
  'utf8',
);

test('OANDA transaction synchronization enumerates every active account', () => {
  assert.match(source, /listBrokerConnectionsForUser/);
  assert.match(source, /connection\.isActive && connection\.broker === 'oanda'/);
  assert.match(source, /for \(const account of accounts\)/);
  assert.match(source, /getDecryptedBrokerCredentials\(userId, account\.id\)/);
  assert.match(source, /brokerAccountId: creds\.accountId/);
  assert.match(source, /syncedAccounts \+= 1/);
  assert.doesNotMatch(source, /resolveActiveBrokerForUser/);
});

test('Trade Activity reconciles closes from authoritative OANDA transactions instead of inferring repeated closes', () => {
  assert.match(reconciliationSource, /syncOandaTransactionsForUser/);
  assert.match(reconciliationSource, /brokerAccountId: credentials\.accountId/);
  assert.match(reconciliationSource, /token: credentials\.token/);
  assert.doesNotMatch(reconciliationSource, /active-trades\/analysis/);
  assert.doesNotMatch(reconciliationSource, /eventType:\s*'closed'/);
  assert.doesNotMatch(reconciliationSource, /no longer present in OANDA open trades/i);
});
