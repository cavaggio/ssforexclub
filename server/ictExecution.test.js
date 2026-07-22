import { test } from 'node:test';
import assert from 'node:assert/strict';

// The live-ack guard reads this at call time. Tests that must pass it set it true;
// the shadow / auto-disabled tests block earlier so it doesn't matter for them.
process.env.FOREX_ALLOW_LIVE_EXECUTION = 'true';

const { executeIctTrade } = await import('./ictExecution.js');

const NOW = new Date('2026-06-04T15:00:00Z');
const LIVE_CFG = { mode: 'live', autoTradeEnabled: true, minConfidence: 93, minRR: 2.0, maxRiskPercent: 1, signalTtlSec: 300 };
const freshId = (pair = 'EUR_USD') => `${pair}:${NOW.getTime() - 30_000}`;   // 30s old → fresh
const staleId = (pair = 'EUR_USD') => `${pair}:${NOW.getTime() - 600_000}`;  // 600s old → stale

const validParams = () => ({
  pair: 'EUR_USD', direction: 'long', units: 0,
  entry: 1.1000, stopLoss: 1.0980, targetProfit: 1.1040, ictSignalId: freshId(),
});

const goodAnalysis = (over = {}) => async () => ({
  signal: 'buy', confidence: 95, rr: 2.5, signalId: freshId(),
  entry: 1.1000, stopLoss: 1.0980, target1: 1.1040,
  atrPips: 10, setupType: 'ICT 2022 Model', conceptsDetected: [], concepts: {},
  ...over,
});
const goodAccount = async () => ({ balance: '10000', marginRate: '0.03', marginAvailable: '9000' });

function mockClient() {
  const calls = [];
  return {
    accountId: 'ACC-001',
    calls,
    post: async (path, body) => {
      calls.push({ path, body });
      return { orderFillTransaction: { id: 'tx1', price: '1.1001', tradeOpened: { tradeID: 'T123' } } };
    },
  };
}

const baseDeps = (over = {}) => ({
  client: mockClient(), now: NOW, cfg: LIVE_CFG,
  getAnalysis: goodAnalysis(), getAccount: goodAccount, reconcile: async () => false,
  getOpen: async () => [],
  ...over,
});

test('shadow mode blocks execution', async () => {
  const r = await executeIctTrade(validParams(), baseDeps({ cfg: { ...LIVE_CFG, mode: 'shadow' } }));
  assert.equal(r.blocked, true);
  assert.equal(r.success, false);
  assert.match(r.reason, /execution disabled/i);
});

test('auto-trade disabled blocks execution', async () => {
  const r = await executeIctTrade(validParams(), baseDeps({ cfg: { ...LIVE_CFG, autoTradeEnabled: false } }));
  assert.equal(r.blocked, true);
  assert.match(r.reason, /execution disabled/i);
});

test('stale signal is rejected', async () => {
  const r = await executeIctTrade({ ...validParams(), ictSignalId: staleId() }, baseDeps());
  assert.equal(r.blocked, true);
  assert.match(r.reason, /stale/i);
});

test('low confidence is rejected', async () => {
  const r = await executeIctTrade(validParams(), baseDeps({ getAnalysis: goodAnalysis({ confidence: 92 }) }));
  assert.equal(r.blocked, true);
  assert.match(r.reason, /confidence/i);
});

test('an injected lower threshold cannot bypass the hard 93% ICT floor', async () => {
  const r = await executeIctTrade(validParams(), baseDeps({
    cfg: { ...LIVE_CFG, minConfidence: 80 },
    getAnalysis: goodAnalysis({ confidence: 92 }),
  }));
  assert.equal(r.blocked, true);
  assert.match(r.reason, /92 < 93/);
});

test('low RR is rejected', async () => {
  const r = await executeIctTrade(validParams(), baseDeps({ getAnalysis: goodAnalysis({ rr: 1.5 }) }));
  assert.equal(r.blocked, true);
  assert.match(r.reason, /RR/i);
});

test('missing credentials is rejected', async () => {
  const r = await executeIctTrade(validParams(), baseDeps({ client: null }));
  assert.equal(r.blocked, true);
  assert.match(r.reason, /credentials|client/i);
});

test('duplicate open trade is rejected', async () => {
  const r = await executeIctTrade(validParams(), baseDeps({ reconcile: async () => true }));
  assert.equal(r.blocked, true);
  assert.match(r.reason, /duplicate/i);
});

test('direction mismatch with the recomputed signal is rejected', async () => {
  // Server is authoritative: a SELL signal can't back a long request.
  const r = await executeIctTrade(validParams(), baseDeps({ getAnalysis: goodAnalysis({ signal: 'sell' }) }));
  assert.equal(r.blocked, true);
  assert.match(r.reason, /no current ICT buy signal/i);
});

test('valid trade submits through the existing OANDA client', async () => {
  const client = mockClient();
  const r = await executeIctTrade(validParams(), baseDeps({ client }));
  assert.equal(r.success, true, r.reason);
  assert.equal(r.executionState, 'FILLED');
  assert.equal(r.tradeId, 'T123');
  assert.equal(r.entryConfidence, 95);
  // It went through the existing per-request OANDA client order POST.
  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0].path, /\/v3\/accounts\/ACC-001\/orders$/);
  assert.equal(client.calls[0].body.order.type, 'MARKET');
  assert.ok(client.calls[0].body.order.stopLossOnFill && client.calls[0].body.order.takeProfitOnFill, 'SL/TP attached on fill');
  assert.ok(Math.abs(r.units) >= 1, 'server-sized a real position');
});
