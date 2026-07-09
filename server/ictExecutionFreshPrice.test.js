import test from 'node:test';
import assert from 'node:assert/strict';
import { executeIctTrade } from './ictExecution.js';

function baseParams(overrides = {}) {
  return {
    pair: 'EUR_JPY',
    direction: 'long',
    entry: 184.915,
    stopLoss: 184.864,
    targetProfit: 185.000,
    ictSignalId: `EUR_JPY:${Date.now()}`,
    environment: 'practice',
    ...overrides,
  };
}

function fakeAccount() {
  return {
    balance: '10000',
    marginAvailable: '100000',
    marginRate: '0.0333',
  };
}

function fakeAnalysis() {
  return {
    signal: 'buy',
    confidence: 90,
    rr: 1.7,
    setupType: 'Turtle Soup',
    concepts: { killzone: 'New York PM' },
    signalId: `EUR_JPY:${Date.now()}`,
  };
}

test('ICT execution blocks stale BUY target before OANDA TAKE_PROFIT_ON_FILL_LOSS', async () => {
  const client = {
    accountId: 'test',
    environment: 'practice',
    post: async () => {
      throw new Error('post should not be called');
    },
  };

  const result = await executeIctTrade(baseParams(), {
    client,
    cfg: { mode: 'live', autoTradeEnabled: true, minConfidence: 80, minRR: 1.5.5, maxRiskPercent: 1.25, signalTtlSec: 300 },
    getAnalysis: async () => fakeAnalysis(),
    getAccount: async () => fakeAccount(),
    reconcile: async () => false,
  });

  assert.equal(result.success, false);
  assert.equal(result.blocked, true);
  assert.match(result.reason, /Stale\/invalid protective prices|Fresh price check failed|TAKE_PROFIT_ON_FILL_LOSS/);
});
