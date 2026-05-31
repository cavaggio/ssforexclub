/**
 * server/oandaClose.test.js
 *
 * Tests for the close-trade execution path. Pure-function level: the helper
 * is invoked with a mock per-request client so we can pin URL + body +
 * success/cancel/error shape without hitting the OANDA network.
 *
 * Run with:   node --test server/oandaClose.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeBrokerTrade } from './oandaTrade.js';

function makeClient({ response, throwError } = {}) {
  const calls = [];
  return {
    accountId: 'TEST-ACCT',
    environment: 'practice',
    baseUrl: 'https://api-fxpractice.oanda.com',
    isDefault: false,
    get:  async () => ({}),
    post: async () => ({}),
    put:  async (path, body) => {
      calls.push({ method: 'PUT', path, body });
      if (throwError) throw new Error(throwError);
      return response;
    },
    calls,
  };
}

test('closeBrokerTrade: requires client', async () => {
  await assert.rejects(
    () => closeBrokerTrade({ tradeId: '1' }),
    /per-request client is required/,
  );
});

test('closeBrokerTrade: requires tradeId', async () => {
  const client = makeClient({ response: {} });
  await assert.rejects(
    () => closeBrokerTrade({ client }),
    /tradeId is required/,
  );
});

test('closeBrokerTrade: full close → PUT /trades/{id}/close with units=ALL', async () => {
  const client = makeClient({
    response: {
      orderFillTransaction: { id: 'OF-1', units: '-1000', pl: '12.34' },
    },
  });
  const r = await closeBrokerTrade({
    tradeId: 'T-100',
    instrument: 'EUR_USD',
    client,
  });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].path, '/v3/accounts/TEST-ACCT/trades/T-100/close');
  assert.deepEqual(client.calls[0].body, { units: 'ALL' });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'closed');
  assert.equal(r.tradeId, 'T-100');
  assert.equal(r.unitsClosed, 1000);
  assert.equal(r.brokerOrderId, 'OF-1');
  assert.equal(r.pnl, 12.34);
});

test('closeBrokerTrade: partial close → PUT with numeric units string', async () => {
  const client = makeClient({
    response: {
      orderFillTransaction: { id: 'OF-2', units: '-250', pl: '3.21' },
    },
  });
  const r = await closeBrokerTrade({
    tradeId: 'T-200',
    instrument: 'EUR_USD',
    units: 250,
    client,
  });
  assert.equal(client.calls[0].body.units, '250');
  assert.equal(r.action, 'partial_closed');
  assert.equal(r.unitsClosed, 250);
});

test('closeBrokerTrade: rounds and floors negative/fractional units to integer ≥1', async () => {
  const client = makeClient({
    response: { orderFillTransaction: { id: 'OF-3', units: '-1', pl: '0' } },
  });
  await closeBrokerTrade({ tradeId: 'T-300', units: 0.4, client });
  assert.equal(client.calls[0].body.units, '1');
});

test('closeBrokerTrade: orderCancelTransaction → ok=false with reason', async () => {
  const client = makeClient({
    response: {
      orderCancelTransaction: { reason: 'INSUFFICIENT_MARGIN' },
    },
  });
  const r = await closeBrokerTrade({ tradeId: 'T-400', client });
  assert.equal(r.ok, false);
  assert.match(r.message, /INSUFFICIENT_MARGIN/);
});

test('closeBrokerTrade: client throws → ok=false with error message', async () => {
  const client = makeClient({ throwError: 'OANDA 401 — invalid token' });
  const r = await closeBrokerTrade({ tradeId: 'T-500', client });
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid token/);
  assert.match(r.message, /Close failed/);
});
