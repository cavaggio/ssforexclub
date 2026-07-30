import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildActualTradeLifecycleRow,
  classifyActualResult,
  computeActualRealizedR,
} from './actualTradeReconciliationCore.js';

test('actual result is sourced from the closed OANDA trade P&L', () => {
  assert.equal(classifyActualResult('CLOSED', '125.50'), 'win');
  assert.equal(classifyActualResult('CLOSED', '-40.00'), 'loss');
  assert.equal(classifyActualResult('CLOSED', '0'), 'breakeven');
  assert.equal(classifyActualResult('OPEN', '100'), 'open');
});

test('realized R prefers broker P&L divided by immutable planned risk', () => {
  assert.equal(computeActualRealizedR({ realizedPl: 750, riskUsd: 500 }), 1.5);
});

test('realized R falls back to OANDA entry, close, and stop geometry', () => {
  assert.equal(computeActualRealizedR({
    direction: 'long',
    entryPrice: 100,
    exitPrice: 103,
    stopLoss: 98,
  }), 1.5);
  assert.equal(computeActualRealizedR({
    direction: 'short',
    entryPrice: 100,
    exitPrice: 97,
    stopLoss: 102,
  }), 1.5);
});

test('lifecycle row preserves originating account and engine instead of current watchlist state', () => {
  const row = buildActualTradeLifecycleRow({
    opening: {
      trade_log_id: 'log-1',
      user_id: 'user-1',
      broker_account_id: '101-001-39311050-001',
      environment: 'practice',
      engine: 'ict',
      broker_trade_id: '85',
      pair: 'USD_CHF',
      direction: 'long',
      opened_at: '2026-07-21T14:35:48.369Z',
      risk_usd: 500,
      raw_payload: { engine: 'ict' },
    },
    trade: {
      id: '85',
      instrument: 'USD_CHF',
      state: 'CLOSED',
      openTime: '2026-07-21T14:35:48.369Z',
      closeTime: '2026-07-21T15:00:00.000Z',
      price: '0.81252',
      averageClosePrice: '0.81500',
      initialUnits: '1703086',
      realizedPL: '750',
      stopLossOrder: { price: '0.81073' },
      takeProfitOrder: { price: '0.81500' },
      openingTransactionIDs: ['84'],
      closingTransactionIDs: ['90'],
    },
    reconciledAt: new Date('2026-07-30T16:00:00.000Z'),
  });

  assert.equal(row.broker_account_id, '101-001-39311050-001');
  assert.equal(row.engine, 'ict');
  assert.equal(row.broker_trade_id, '85');
  assert.equal(row.pair, 'USD_CHF');
  assert.equal(row.result, 'win');
  assert.equal(row.realized_r, 1.5);
  assert.equal(row.engine_attribution_source, 'trade_log_open');
  assert.equal(row.actual_outcome_source, 'oanda_trade_detail');
});
