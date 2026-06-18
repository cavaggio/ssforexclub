import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateNinjaTraderCredentials,
  buildNinjaTraderClient,
  placeNinjaTraderOrder,
  closeNinjaTraderPosition,
  getNinjaTraderAccounts,
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
