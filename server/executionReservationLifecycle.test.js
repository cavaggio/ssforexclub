import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const savedEnv = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
};
delete process.env.SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const reservations = await import('./executionReservations.js');

function reset() {
  reservations.__resetExecutionReservationsForTests();
}

test.after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

test('a full close releases the same setup immediately by trade id', async () => {
  reset();
  const fingerprint = 'account-1:USD_JPY:long:setup-a';
  const first = await reservations.reserveExecution({
    fingerprint,
    accountId: 'account-1',
    pair: 'USD_JPY',
    direction: 'long',
  });
  assert.equal(first.allowed, true);

  await reservations.markExecutionOpen({ hash: first.hash, tradeId: 'trade-101' });
  const blocked = await reservations.reserveExecution({
    fingerprint,
    accountId: 'account-1',
    pair: 'USD_JPY',
    direction: 'long',
  });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /setup already open/);

  await reservations.releaseExecutionByTradeId('trade-101');
  const retry = await reservations.reserveExecution({
    fingerprint,
    accountId: 'account-1',
    pair: 'USD_JPY',
    direction: 'long',
  });
  assert.equal(retry.allowed, true);
});

test('broker-clear reconciliation releases stale open reservations by account, pair, and direction', async () => {
  reset();
  const fingerprint = 'account-2:EUR_USD:short:setup-b';
  const first = await reservations.reserveExecution({
    fingerprint,
    accountId: 'account-2',
    pair: 'EUR_USD',
    direction: 'short',
  });
  await reservations.markExecutionOpen({ hash: first.hash, tradeId: 'trade-202' });

  const cleanup = await reservations.releaseExecutionsForPairDirection({
    accountId: 'account-2',
    pair: 'EUR/USD',
    direction: 'short',
    statuses: ['open'],
  });
  assert.equal(cleanup.released, 1);

  const retry = await reservations.reserveExecution({
    fingerprint,
    accountId: 'account-2',
    pair: 'EUR_USD',
    direction: 'short',
  });
  assert.equal(retry.allowed, true);
});

test('broker-clear reconciliation does not erase a concurrent in-flight reservation', async () => {
  reset();
  const fingerprint = 'account-4:USD_CAD:long:setup-d';
  const first = await reservations.reserveExecution({
    fingerprint,
    accountId: 'account-4',
    pair: 'USD_CAD',
    direction: 'long',
  });
  assert.equal(first.allowed, true);

  const cleanup = await reservations.releaseExecutionsForPairDirection({
    accountId: 'account-4',
    pair: 'USD_CAD',
    direction: 'long',
    statuses: ['open'],
  });
  assert.equal(cleanup.released, 0);

  const blocked = await reservations.reserveExecution({
    fingerprint,
    accountId: 'account-4',
    pair: 'USD_CAD',
    direction: 'long',
  });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /setup already reserved/);
});

test('broker-clear cleanup does not erase a post-stop-loss reentry lock', async () => {
  reset();
  const fingerprint = 'account-3:GBP_USD:long:setup-c';
  const first = await reservations.reserveExecution({
    fingerprint,
    accountId: 'account-3',
    pair: 'GBP_USD',
    direction: 'long',
  });
  await reservations.markExecutionOpen({ hash: first.hash, tradeId: 'trade-303' });
  await reservations.lockTradeAfterLoss('trade-303', 1);

  const cleanup = await reservations.releaseExecutionsForPairDirection({
    accountId: 'account-3',
    pair: 'GBP_USD',
    direction: 'long',
    statuses: ['open'],
  });
  assert.equal(cleanup.released, 0);

  const blocked = await reservations.reserveExecution({
    fingerprint,
    accountId: 'account-3',
    pair: 'GBP_USD',
    direction: 'long',
  });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /loss_locked/);
});

test('all broker close and reconciliation paths carry reservation cleanup contracts', () => {
  const tradeSource = readFileSync(new URL('./oandaTrade.js', import.meta.url), 'utf8');
  const ictSource = readFileSync(new URL('./ictExecution.js', import.meta.url), 'utf8');
  const syncSource = readFileSync(
    new URL('../web/lib/oandaTransactionSync.ts', import.meta.url),
    'utf8',
  );

  assert.match(tradeSource, /releaseExecutionsForPairDirection/);
  assert.match(tradeSource, /statuses: \['open'\]/);
  assert.match(tradeSource, /\[STALE RESERVATION RELEASED\]/);
  assert.match(tradeSource, /releaseExecutionByTradeId\(tradeId, 'released'\)/);
  assert.match(tradeSource, /releaseExecution\(executionReservationHash, 'no_fill'\)/);
  assert.match(ictSource, /releaseExecution\(params\.__reservationHash, 'no_fill'\)/);

  assert.match(syncSource, /fullyClosed: boolean/);
  assert.match(syncSource, /status: 'released'/);
  assert.match(syncSource, /status: 'loss_locked'/);
  assert.match(syncSource, /eventType: event\.fullyClosed \? 'closed' : 'partial_closed'/);
  assert.match(syncSource, /if \(result\.ok && event\.fullyClosed && event\.tradeId\)/);
});
