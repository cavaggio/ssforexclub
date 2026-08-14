import { test } from 'node:test';
import assert from 'node:assert/strict';

// The live-ack guard reads this at call time. Tests that must pass it set it true;
// the shadow / auto-disabled tests block earlier so it doesn't matter for them.
process.env.FOREX_ALLOW_LIVE_EXECUTION = 'true';

const { executeIctTrade } = await import('./ictExecution.js');

const NOW = new Date('2026-06-04T15:00:00Z');
const LIVE_CFG = { mode: 'live', autoTradeEnabled: true, minConfidence: 80, minRR: 2.0, maxRiskPercent: 1, signalTtlSec: 300 };
const freshId = (pair = 'EUR_USD') => `${pair}:${NOW.getTime() - 30_000}`;   // 30s old → fresh
const staleId = (pair = 'EUR_USD') => `${pair}:${NOW.getTime() - 600_000}`;  // 600s old → stale

const validParams = () => ({
  pair: 'EUR_USD', direction: 'long', units: 0,
  entry: 1.1000, stopLoss: 1.0980, targetProfit: 1.1040, ictSignalId: freshId(),
});

const goodAnalysis = (over = {}) => async () => ({
  signal: 'buy', confidence: 95, targetHitConfidence: 95, confluenceScore: 95,
  rr: 2.5, signalId: freshId(),
  entry: 1.1000, idealEntry: 1.1000, entryZoneLow: 1.0998, entryZoneHigh: 1.1002,
  entrySource: 'FVG', stopLoss: 1.0980, target1: 1.1040,
  entryTimeframe: '5M', entryCandle: { triggerReady: true },
  atrPips: 10, freshImpulse: true, triggerAgeBars: 0,
  h1Transition: {
    ready: true,
    transitionId: 'bullish:2026-06-04T15:00:00.000Z',
    reason: 'Test H1 countertrend-to-bias transition is ready.',
  },
  minimumRR: 1.5, targetAdjustedToMinRR: false,
  setupType: 'ICT 2022 Model', conceptsDetected: [], concepts: {},
  ...over,
});
const goodAccount = async () => ({ balance: '10000', marginRate: '0.03', marginAvailable: '9000' });

function mockClient(accountId = 'ACC-001') {
  const calls = [];
  return {
    accountId,
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
  const r = await executeIctTrade(validParams(), baseDeps({ getAnalysis: goodAnalysis({ confidence: 79 }) }));
  assert.equal(r.blocked, true);
  assert.match(r.reason, /confidence/i);
});

test('an injected lower threshold cannot bypass the authoritative ICT floor', async () => {
  const r = await executeIctTrade(validParams(), baseDeps({
    cfg: { ...LIVE_CFG, minConfidence: 0 },
    getAnalysis: goodAnalysis({ confidence: 79 }),
  }));
  assert.equal(r.blocked, true);
  assert.match(r.reason, /79 < (?:80|93)/);
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

test('a qualified score cannot bypass both ICT entry-authorization paths', async () => {
  const r = await executeIctTrade(validParams(), baseDeps({
    getAnalysis: goodAnalysis({
      h1Transition: { ready: false, transitionId: null, reason: 'Wait for the new bullish H1 candle.' },
    }),
  }));
  assert.equal(r.blocked, true);
  assert.match(r.reason, /entry-authorization gate failed/i);
});

test('an H1 transition cannot execute without a fresh M5 setup', async () => {
  const r = await executeIctTrade(validParams(), baseDeps({
    getAnalysis: goodAnalysis({ entryCandle: { triggerReady: false } }),
  }));
  assert.equal(r.blocked, true);
  assert.match(r.reason, /fresh 5M entry setup/i);
});

test('a fresh M5 continuation breakout can execute after the H1 transition window expires', async () => {
  const client = mockClient('ACC-CONTINUATION');
  const r = await executeIctTrade(validParams(), baseDeps({
    client,
    getAnalysis: goodAnalysis({
      h1Transition: { ready: false, transitionId: null, reason: 'H1 transition window ended.' },
      continuationBreakout: {
        ready: true,
        mode: 'm5_continuation_breakout',
        cycleId: 'bullish:m5_continuation_breakout:1.1:2026-06-04T14:55:00.000Z',
        reason: 'Fresh aligned M5 continuation breakout.',
      },
    }),
  }));

  assert.equal(r.success, true, r.reason);
  assert.equal(r.entryAuthorization.mode, 'm5_continuation_breakout');
  assert.equal(client.calls.length, 1);
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
