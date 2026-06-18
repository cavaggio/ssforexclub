import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTopstepCredentials,
  evaluateTopstepExecution,
  buildTopstepClient,
  placeTopstepOrder,
  closeTopstepPosition,
  getTopstepAccounts,
  TOPSTEP_COMPLIANCE_MESSAGE,
} from './topstepClient.js';

const GOOD_CREDS = { userName: 'trader1', apiKey: 'key-abc-123' };

function fakeFetch(body, ok = true, status = 200) {
  return async () => ({ ok, status, text: async () => JSON.stringify(body) });
}

function clearTopstepFlags() {
  delete process.env.TOPSTEP_ENABLED;
  delete process.env.TOPSTEP_CLOUD_EXECUTION_ALLOWED;
  delete process.env.TOPSTEP_LIVE_EXECUTION_ENABLED;
}

test('validateTopstepCredentials requires userName and apiKey', () => {
  assert.equal(validateTopstepCredentials(GOOD_CREDS).ok, true);
  const r = validateTopstepCredentials({ userName: 'x' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['apiKey']);
});

test('execution is blocked while cloud execution is not allowed (compliance)', () => {
  clearTopstepFlags();
  process.env.TOPSTEP_ENABLED = 'true';
  // TOPSTEP_CLOUD_EXECUTION_ALLOWED stays false → blocked with compliance message.
  const gate = evaluateTopstepExecution({ environment: 'evaluation' });
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, TOPSTEP_COMPLIANCE_MESSAGE);
  clearTopstepFlags();
});

test('placeTopstepOrder never transmits while cloud execution is disallowed', async () => {
  clearTopstepFlags();
  process.env.TOPSTEP_ENABLED = 'true';
  let fetched = false;
  const client = buildTopstepClient({
    credentials: GOOD_CREDS,
    environment: 'evaluation',
    fetchImpl: async () => { fetched = true; return { ok: true, status: 200, text: async () => '{}' }; },
  });
  const r = await placeTopstepOrder(client, { accountId: 'A', symbol: 'ES', side: 0, quantity: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
  assert.equal(fetched, false, 'no network call should have been made');
  const c = await closeTopstepPosition(client, { accountId: 'A', symbol: 'ES' });
  assert.equal(c.blocked, true);
  clearTopstepFlags();
});

test('funded execution requires the live flag even when cloud execution is allowed', () => {
  clearTopstepFlags();
  process.env.TOPSTEP_ENABLED = 'true';
  process.env.TOPSTEP_CLOUD_EXECUTION_ALLOWED = 'true';
  // live flag off
  assert.equal(evaluateTopstepExecution({ environment: 'funded' }).allowed, false);
  // evaluation (sim) is allowed once cloud execution is allowed
  assert.equal(evaluateTopstepExecution({ environment: 'evaluation' }).allowed, true);
  process.env.TOPSTEP_LIVE_EXECUTION_ENABLED = 'true';
  assert.equal(evaluateTopstepExecution({ environment: 'funded' }).allowed, true);
  clearTopstepFlags();
});

test('orders transmit only when every gate passes', async () => {
  clearTopstepFlags();
  process.env.TOPSTEP_ENABLED = 'true';
  process.env.TOPSTEP_CLOUD_EXECUTION_ALLOWED = 'true';
  const client = buildTopstepClient({
    credentials: GOOD_CREDS,
    environment: 'evaluation',
    fetchImpl: fakeFetch({ orderId: 'ts-1' }),
  });
  const r = await placeTopstepOrder(client, { accountId: 'A', contractId: 'CON.F.US.ES', side: 0, quantity: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.order.orderId, 'ts-1');
  clearTopstepFlags();
});

test('Topstep functions reject a non-Topstep client', async () => {
  await assert.rejects(() => getTopstepAccounts({ provider: 'oanda' }), /not a Topstep client/);
  await assert.rejects(() => placeTopstepOrder({ provider: 'ninjatrader' }, {}), /not a Topstep client/);
});
