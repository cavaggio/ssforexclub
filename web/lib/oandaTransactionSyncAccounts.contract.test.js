import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalizeTradeActivityRows } from './tradeActivityCanonical.js';

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

test('canonical Trade Activity removes phantom closes and keeps one terminal broker outcome per trade', () => {
  const rows = [
    { id: 'open', created_at: '2026-08-19T14:22:21.000Z', event_type: 'opened', trade_id: '1341', instrument: 'USD_JPY' },
    { id: 'phantom-1', created_at: '2026-08-19T14:52:30.000Z', event_type: 'closed', trade_id: null, instrument: 'USD_JPY' },
    { id: 'phantom-2', created_at: '2026-08-19T14:53:00.000Z', event_type: 'closed', trade_id: null, instrument: 'USD_JPY' },
    { id: 'weak-close', created_at: '2026-08-19T14:57:42.000Z', event_type: 'closed', trade_id: '1341', instrument: 'USD_JPY' },
    {
      id: 'broker-close',
      created_at: '2026-08-19T14:57:49.000Z',
      event_type: 'closed',
      trade_id: '1341',
      instrument: 'USD_JPY',
      exit_price: 158.302,
      realized_pl: -0.89,
      raw_payload: { source: 'oanda_transaction_sync', transactionId: '1600' },
    },
  ];

  const canonical = canonicalizeTradeActivityRows(rows);
  assert.deepEqual(canonical.map((row) => row.id), ['broker-close', 'open']);
});
