import test from 'node:test';
import assert from 'node:assert/strict';
import { executeIctTrade } from './ictExecution.js';

function baseParams(overrides = {}) {
  return {
    pair: 'GBP_JPY',
    direction: 'long',
    entry: 184.915,
    stopLoss: 184.864,
    targetProfit: 185.000,
    ictSignalId: `GBP_JPY:${Date.now()}`,
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
    confidence: 95,
    confluenceScore: 95,
    rr: 1.7,
    entry: 184.915,
    idealEntry: 184.915,
    entryZoneLow: 184.905,
    entryZoneHigh: 184.925,
    entrySource: 'FVG',
    stopLoss: 184.864,
    target1: 185.000,
    entryTimeframe: '5M',
    entryCandle: { triggerReady: true },
    atrPips: 10,
    freshImpulse: true,
    triggerAgeBars: 0,
    minimumRR: 1.5,
    entryAuthorization: {
      ready: true,
      mode: 'initial_reversal_mss',
      cycleId: 'GBP_JPY:2026-06-04:bullish:initial',
      parentCycleId: 'GBP_JPY:2026-06-04:bullish',
    },
    marketMakerModel: {
      studyReady: true,
      stage: 'DISTRIBUTION_ACTIVE',
    },
    h1Transition: {
      ready: true,
      transitionId: 'bullish:2026-06-04T15:00:00Z',
      reason: 'Test H1 transition is ready.',
    },
    setupType: 'Turtle Soup',
    concepts: { killzone: 'New York PM' },
    signalId: `GBP_JPY:${Date.now()}`,
  };
}

test('ICT execution blocks stale BUY target before OANDA TAKE_PROFIT_ON_FILL_LOSS', async () => {
  const client = {
    accountId: 'test',
    environment: 'practice',
    get: async () => ({
      prices: [{
        instrument: 'GBP_JPY',
        bids: [{ price: '185.000' }],
        asks: [{ price: '185.010' }],
      }],
    }),
    post: async () => {
      throw new Error('post should not be called');
    },
  };

  const result = await executeIctTrade(baseParams(), {
    client,
    cfg: { mode: 'live', autoTradeEnabled: true, minConfidence: 80, minRR: 1.5, maxRiskPercent: 1.25, signalTtlSec: 300 },
    getAnalysis: async () => fakeAnalysis(),
    getAccount: async () => fakeAccount(),
    getOpen: async () => [],
    reconcile: async () => false,
  });

  assert.equal(result.success, false);
  assert.equal(result.blocked, true);
  assert.match(result.reason, /Stale\/invalid protective prices|Fresh price check failed|TAKE_PROFIT_ON_FILL_LOSS/);
});
