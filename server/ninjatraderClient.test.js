import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateNinjaTraderCredentials,
  buildNinjaTraderClient,
  placeNinjaTraderOrder,
  closeNinjaTraderPosition,
  getNinjaTraderAccounts,
  getNinjaTraderDiagnostics,
} from './ninjatraderClient.js';

const GOOD_CREDS = {
  name: 'trader1',
  password: 'pw',
  appId: 'SignalStack',
  appVersion: '1.0',
  cid: 'client-123',
  sec: 'secret-value',
};

// Minimal fake fetch returning a JSON body.
function fakeFetch(body, ok = true, status = 200) {
  return async () => ({ ok, status, text: async () => JSON.stringify(body) });
}

test('validateNinjaTraderCredentials requires all six fields', () => {
  assert.equal(validateNinjaTraderCredentials(GOOD_CREDS).ok, true);
  const missing = validateNinjaTraderCredentials({ name: 'x', password: 'y' });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing.sort(), ['appId', 'appVersion', 'cid', 'sec'].sort());
  assert.equal(validateNinjaTraderCredentials(null).ok, false);
  assert.equal(validateNinjaTraderCredentials({ ...GOOD_CREDS, sec: '   ' }).ok, false);
});

test('buildNinjaTraderClient throws when the provider master flag is off', () => {
  delete process.env.NINJATRADER_FUTURES_ENABLED;
  assert.throws(() => buildNinjaTraderClient({ credentials: GOOD_CREDS }), /disabled/);
});

test('sim orders execute when the master flag is on', async () => {
  process.env.NINJATRADER_FUTURES_ENABLED = 'true';
  delete process.env.NINJATRADER_LIVE_EXECUTION_ENABLED;
  const client = buildNinjaTraderClient({
    credentials: GOOD_CREDS,
    environment: 'sim',
    fetchImpl: fakeFetch({ orderId: 'o1' }),
  });
  assert.equal(client.mode, 'sim');
  const r = await placeNinjaTraderOrder(client, { accountId: 'A', symbol: 'ES', side: 'buy', quantity: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.order.orderId, 'o1');
});

test('live orders are blocked unless NINJATRADER_LIVE_EXECUTION_ENABLED', async () => {
  process.env.NINJATRADER_FUTURES_ENABLED = 'true';
  delete process.env.NINJATRADER_LIVE_EXECUTION_ENABLED;
  const client = buildNinjaTraderClient({
    credentials: GOOD_CREDS,
    environment: 'live',
    fetchImpl: fakeFetch({ orderId: 'should-not-happen' }),
  });
  assert.equal(client.mode, 'live');
  const r = await placeNinjaTraderOrder(client, { accountId: 'A', symbol: 'ES', side: 'buy', quantity: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);

  const c = await closeNinjaTraderPosition(client, { accountId: 'A', symbol: 'ES' });
  assert.equal(c.blocked, true);
});

test('live orders execute when the live flag is also on', async () => {
  process.env.NINJATRADER_FUTURES_ENABLED = 'true';
  process.env.NINJATRADER_LIVE_EXECUTION_ENABLED = 'true';
  const client = buildNinjaTraderClient({
    credentials: GOOD_CREDS,
    environment: 'live',
    fetchImpl: fakeFetch({ orderId: 'live-1' }),
  });
  const r = await placeNinjaTraderOrder(client, { accountId: 'A', symbol: 'ES', side: 'buy', quantity: 1 });
  assert.equal(r.ok, true);
  delete process.env.NINJATRADER_LIVE_EXECUTION_ENABLED;
});

test('NinjaTrader functions reject a non-NinjaTrader client', async () => {
  await assert.rejects(() => getNinjaTraderAccounts({ provider: 'oanda' }), /not a NinjaTrader client/);
  await assert.rejects(() => placeNinjaTraderOrder({ provider: 'topstep' }, {}), /not a NinjaTrader client/);
});

test('diagnostics: missing fields => BROKER_AUTH_FAILED, never throws', async () => {
  process.env.NINJATRADER_FUTURES_ENABLED = 'true';
  const d = await getNinjaTraderDiagnostics({ credentials: { name: 'x' }, environment: 'paper' });
  assert.equal(d.ok, false);
  assert.equal(d.code, 'BROKER_AUTH_FAILED');
  assert.equal(d.validationStatus, 'invalid');
});

test('diagnostics: connector disabled => CONNECTOR_DISABLED', async () => {
  delete process.env.NINJATRADER_FUTURES_ENABLED;
  const d = await getNinjaTraderDiagnostics({ credentials: GOOD_CREDS, environment: 'paper' });
  assert.equal(d.code, 'CONNECTOR_DISABLED');
});

test('diagnostics: gateway rejects auth (HTTP error) => BROKER_AUTH_FAILED, no throw', async () => {
  process.env.NINJATRADER_FUTURES_ENABLED = 'true';
  const failFetch = async () => ({ ok: false, status: 401, text: async () => '{"error":"bad creds"}' });
  const d = await getNinjaTraderDiagnostics({ credentials: GOOD_CREDS, environment: 'paper', fetchImpl: failFetch });
  assert.equal(d.ok, false);
  assert.equal(d.code, 'BROKER_AUTH_FAILED');
});

test('diagnostics: valid paper account => OK, validated, execution NOT allowed (paper)', async () => {
  process.env.NINJATRADER_FUTURES_ENABLED = 'true';
  delete process.env.NINJATRADER_LIVE_EXECUTION_ENABLED;
  const okFetch = fakeFetch({ accessToken: 't', accounts: [{ name: 'Sim101', balance: 5000 }], positions: [] });
  const d = await getNinjaTraderDiagnostics({ credentials: GOOD_CREDS, environment: 'paper', fetchImpl: okFetch });
  assert.equal(d.code, 'OK');
  assert.equal(d.validationStatus, 'valid');
  assert.equal(d.environment, 'paper');
  assert.equal(d.accountMode, 'simulated');
  assert.equal(d.selectedAccount, 'Sim101');
  assert.equal(d.balance, 5000);
  assert.equal(d.executionAllowed, false);
});

test('diagnostics: live account with live flag => executionAllowed true', async () => {
  process.env.NINJATRADER_FUTURES_ENABLED = 'true';
  process.env.NINJATRADER_LIVE_EXECUTION_ENABLED = 'true';
  const okFetch = fakeFetch({ accessToken: 't', accounts: [{ name: 'Live-1', balance: 25000 }], positions: [{ symbol: 'ES' }] });
  const d = await getNinjaTraderDiagnostics({ credentials: GOOD_CREDS, environment: 'live', fetchImpl: okFetch });
  assert.equal(d.environment, 'live');
  assert.equal(d.executionAllowed, true);
  assert.equal(d.openPositions, 1);
  delete process.env.NINJATRADER_LIVE_EXECUTION_ENABLED;
});
