import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildActualTradeLifecycleRow,
  classifyActualResult,
  computeActualRealizedR,
  computeTradeExcursion,
} from './actualTradeReconciliationCore.js';

test('actual result is sourced from the closed OANDA trade P&L', () => {
  assert.equal(classifyActualResult('CLOSED', '125.50'), 'win');
  assert.equal(classifyActualResult('CLOSED', '-40.00'), 'loss');
  assert.equal(classifyActualResult('CLOSED', '0'), 'breakeven');
  assert.equal(classifyActualResult('OPEN', '100'), 'open');
});

test('MFE and MAE are measured from the exact broker trade candle path', () => {
  const excursion = computeTradeExcursion({
    pair: 'EUR_USD', direction: 'long', entryPrice: 1.1000, stopLoss: 1.0980,
    candles: [
      { mid: { h: '1.1010', l: '1.0995' } },
      { mid: { h: '1.1030', l: '1.0990' } },
    ],
  });
  assert.equal(excursion.mfePips, 30);
  assert.equal(excursion.maePips, 10);
  assert.equal(excursion.mfeR, 1.5);
  assert.equal(excursion.maeR, -0.5);
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
      raw_payload: {
        engine: 'ict',
        result: {
          executed: [{
            entryContext: {
              candidateSignalId: 'USD_CHF:1784650000000',
              timeframeState: { d1: 'bullish', h4: 'bullish', h1Structure: 'bullish' },
              h1Momentum: { aligned: true, activeDirection: 'bullish', phase: 'impulse' },
              m5Authorization: { ready: true, mode: 'm5_continuation_breakout', triggerAgeBars: 0, fresh: true },
              powerOfThree: { stage: 'DISTRIBUTION_ACTIVE' },
              htfLiquidityCondition: { keyLevelTap: { aligned: true } },
              correctiveGate: { passed: true, failureCodes: [] },
            },
            signal: {
              combinedLearningContext: { auditId: '123e4567-e89b-42d3-a456-426614174000' },
            },
          }],
        },
      },
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
  assert.equal(row.learning_audit_id, '123e4567-e89b-42d3-a456-426614174000');
  assert.equal(row.pair, 'USD_CHF');
  assert.equal(row.result, 'win');
  assert.equal(row.realized_r, 1.5);
  assert.equal(row.engine_attribution_source, 'trade_log_open');
  assert.equal(row.actual_outcome_source, 'oanda_trade_detail');
  assert.equal(row.candidate_signal_id, 'USD_CHF:1784650000000');
  assert.equal(row.d1_state, 'bullish');
  assert.equal(row.h1_momentum.activeDirection, 'bullish');
  assert.equal(row.m5_trigger_age_bars, 0);
  assert.equal(row.po3_stage, 'DISTRIBUTION_ACTIVE');
});
