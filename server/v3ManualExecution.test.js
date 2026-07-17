import test from 'node:test';
import assert from 'node:assert/strict';

import {
  executeRecentQualifiedV3Signal,
  validateRecentQualifiedV3Signal,
} from './v3ManualExecution.js';

function qualifiedSignal(overrides = {}) {
  return {
    pair: 'EUR_USD',
    direction: 'long',
    architecture: 'independent_v3_raw_market_data',
    legacyScannerUsed: false,
    legacyConfirmationsUsed: false,
    primaryTimeframeAlignment: { passed: true, score: 100 },
    alignment: { timeframeAlignmentScore: 100 },
    v3Score: 70,
    score: 70,
    expectedRR: 2,
    riskReward: 2,
    entry: 1.1,
    stopLoss: 1.095,
    takeProfit: 1.11,
    entryTiming: { status: 'valid_entry' },
    qualityConfirmation: {
      stage1: { allowed: true, state: 'ready', reasons: [] },
      stage2: { allowed: true, state: 'ready', reasons: [] },
    },
    ...overrides,
  };
}

test('Recent Signals button eligibility requires native V3 Stage 1 and Stage 2', () => {
  assert.equal(validateRecentQualifiedV3Signal(qualifiedSignal()).allowed, true);

  const stage1Blocked = validateRecentQualifiedV3Signal(qualifiedSignal({
    qualityConfirmation: {
      stage1: { allowed: false, state: 'blocked', reasons: ['score below minimum'] },
      stage2: { allowed: true, state: 'ready', reasons: [] },
    },
  }));
  assert.equal(stage1Blocked.allowed, false);
  assert.match(stage1Blocked.reasons.join('; '), /Stage 1 did not pass/i);

  const stage2Blocked = validateRecentQualifiedV3Signal(qualifiedSignal({
    qualityConfirmation: {
      stage1: { allowed: true, state: 'ready', reasons: [] },
      stage2: { allowed: false, state: 'watch', reasons: ['waiting for retest'] },
    },
  }));
  assert.equal(stage2Blocked.allowed, false);
  assert.match(stage2Blocked.reasons.join('; '), /Stage 2 did not pass/i);
});

test('manual execution refreshes the exact pair before placing an order', async () => {
  const calls = [];
  const result = await executeRecentQualifiedV3Signal({
    signal: qualifiedSignal(),
    client: { environment: 'practice', accountId: '101-001-00000000-001' },
    refreshCandidate: async ({ candidate }) => {
      calls.push(['refresh', candidate.pair]);
      return {
        allowed: true,
        candidate: qualifiedSignal({ entry: 1.101, entryPrice: 1.101, expectedRR: 1.8, riskReward: 1.8 }),
      };
    },
    execute: async (signal, options) => {
      calls.push(['execute', signal.pair, signal.entry, options.autoAi]);
      return { success: true, tradeId: '123', fillPrice: 1.1011, units: 1000 };
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.refreshPerformed, true);
  assert.deepEqual(calls, [
    ['refresh', 'EUR_USD'],
    ['execute', 'EUR_USD', 1.101, false],
  ]);
});

test('manual execution blocks a stale Recent Signal when fresh Stage 2 fails', async () => {
  let executeCalled = false;
  const result = await executeRecentQualifiedV3Signal({
    signal: qualifiedSignal(),
    client: { environment: 'practice', accountId: '101-001-00000000-001' },
    refreshCandidate: async () => ({
      allowed: false,
      reason: 'entry event is stale',
      candidate: null,
    }),
    execute: async () => {
      executeCalled = true;
      return { success: true };
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.blocked, true);
  assert.equal(result.refreshPerformed, true);
  assert.match(result.reason, /entry event is stale/i);
  assert.equal(executeCalled, false);
});

test('manual execution rejects legacy or incomplete signals before refresh', async () => {
  let refreshCalled = false;
  const result = await executeRecentQualifiedV3Signal({
    signal: qualifiedSignal({ legacyScannerUsed: true }),
    client: { environment: 'practice', accountId: '101-001-00000000-001' },
    refreshCandidate: async () => {
      refreshCalled = true;
      return { allowed: true, candidate: qualifiedSignal() };
    },
  });

  assert.equal(result.blocked, true);
  assert.equal(result.refreshPerformed, false);
  assert.equal(refreshCalled, false);
  assert.match(result.reason, /legacy scanner/i);
});
