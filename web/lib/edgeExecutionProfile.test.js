import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEdgeExecutionProfile,
  extractBrokerAccountId,
  filterRowsForBrokerAccount,
} from './edgeExecutionProfile.js';

test('extracts account IDs from compact production payloads', () => {
  assert.equal(extractBrokerAccountId({
    payload: { broker_account_id: '001-ABC-002' },
    raw_payload: { runId: 'x' },
  }), '001-ABC-002');

  assert.equal(extractBrokerAccountId({
    raw_payload: { request: { accountId: '001-XYZ-003' } },
  }), '001-XYZ-003');
});

test('filters exact broker account and excludes unscoped legacy rows', () => {
  const rows = [
    { id: 'a', payload: { broker_account_id: 'A' } },
    { id: 'b', raw_payload: { brokerAccountId: 'B' } },
    { id: 'unknown' },
  ];

  assert.deepEqual(
    filterRowsForBrokerAccount(rows, 'A').map((row) => row.id),
    ['a'],
  );
});

test('enables only bounded priority learning with enough positive outcomes', () => {
  const profile = buildEdgeExecutionProfile({
    overall: { outcomes: 14 },
    edge: {
      bestPairs: [
        { key: 'EUR_USD', trades: 5, winRate: 60, avgPnl: 12.5 },
        { key: 'GBP_USD', trades: 4, winRate: 75, avgPnl: 9 },
      ],
      worstPairs: [
        { key: 'AUD_CAD', trades: 6, winRate: 25, avgPnl: -8 },
      ],
    },
  });

  assert.equal(profile.enabled, true);
  assert.equal(profile.mode, 'priority_prescan_only');
  assert.deepEqual(profile.preferredPairs, ['EUR_USD', 'GBP_USD']);
  assert.deepEqual(profile.avoidPairs, ['AUD_CAD']);
  assert.equal(profile.safeguards.thresholdsChanged, false);
  assert.equal(profile.safeguards.riskBypass, false);
});

test('insufficient account history cannot influence execution order', () => {
  const profile = buildEdgeExecutionProfile({
    overall: { outcomes: 4 },
    edge: {
      bestPairs: [
        { key: 'EUR_USD', trades: 4, winRate: 100, avgPnl: 10 },
      ],
      worstPairs: [],
    },
  });

  assert.equal(profile.enabled, false);
  assert.deepEqual(profile.preferredPairs, ['EUR_USD']);
  assert.match(profile.reason, /Need 10 scored outcomes/i);
});

test('negative or weak pairs never receive preferred status', () => {
  const profile = buildEdgeExecutionProfile({
    overall: { outcomes: 20 },
    edge: {
      bestPairs: [
        { key: 'EUR_USD', trades: 7, winRate: 42, avgPnl: 3 },
        { key: 'USD_JPY', trades: 7, winRate: 70, avgPnl: -2 },
      ],
      worstPairs: [],
    },
  });

  assert.equal(profile.enabled, false);
  assert.deepEqual(profile.preferredPairs, []);
});
