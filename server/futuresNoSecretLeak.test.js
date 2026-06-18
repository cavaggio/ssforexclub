import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNinjaTraderClient, placeNinjaTraderOrder, getNinjaTraderAccounts } from './ninjatraderClient.js';
import { buildTopstepClient, getTopstepAccounts } from './topstepClient.js';

// The proxy returns ONLY what the connector returns (client object + scanner
// payload). These tests pin that no part of that boundary echoes the secret.
const NT_CREDS = { name: 'u', password: 'PW-SECRET', appId: 'a', appVersion: '1', cid: 'c', sec: 'SEC-SECRET' };
const TS_CREDS = { userName: 'u', apiKey: 'API-SECRET' };

function fakeFetch(body) {
  return async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
}

function assertNoSecrets(value, secrets) {
  const json = JSON.stringify(value) || '';
  for (const s of secrets) {
    assert.ok(!json.includes(s), `secret "${s}" leaked into ${json}`);
  }
}

test('NinjaTrader client object and order result never expose the secret', async () => {
  process.env.NINJATRADER_FUTURES_ENABLED = 'true';
  const client = buildNinjaTraderClient({ credentials: NT_CREDS, environment: 'sim', fetchImpl: fakeFetch({ accounts: [{ id: 'A', balance: 100 }], orderId: 'o1' }) });
  assertNoSecrets(client, ['PW-SECRET', 'SEC-SECRET']);
  await client.authenticate();
  const accounts = await getNinjaTraderAccounts(client);
  assertNoSecrets(accounts, ['PW-SECRET', 'SEC-SECRET']);
  const order = await placeNinjaTraderOrder(client, { accountId: 'A', symbol: 'ES', side: 'buy', quantity: 1 });
  assertNoSecrets(order, ['PW-SECRET', 'SEC-SECRET']);
});

test('Topstep client object and account result never expose the apiKey', async () => {
  process.env.TOPSTEP_ENABLED = 'true';
  const client = buildTopstepClient({ credentials: TS_CREDS, environment: 'evaluation', fetchImpl: fakeFetch({ accounts: [{ id: 'A', balance: 50000 }] }) });
  assertNoSecrets(client, ['API-SECRET']);
  await client.authenticate();
  const accounts = await getTopstepAccounts(client);
  assertNoSecrets(accounts, ['API-SECRET']);
  delete process.env.TOPSTEP_ENABLED;
});
