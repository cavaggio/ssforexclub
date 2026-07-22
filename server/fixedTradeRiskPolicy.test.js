import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FIXED_RISK_PER_TRADE_PERCENT,
  FIXED_STOP_LOSS_PIPS,
  enforceFixedStopGeometry,
  buildFixedStopLossOnFill,
  getLossQuoteHomeConversionFactor,
} from './fixedTradeRiskPolicy.js';
import { computeFixedDollarSizing } from './oandaRiskSizing.js';


test('fixed policy is exactly 1.25% risk with a 20-pip stop', () => {
  assert.equal(FIXED_RISK_PER_TRADE_PERCENT, 1.25);
  assert.equal(FIXED_STOP_LOSS_PIPS, 20);
});


test('EUR_CHF long geometry forces an exact 20-pip stop', () => {
  const geometry = enforceFixedStopGeometry({
    pair: 'EUR_CHF',
    direction: 'long',
    entry: 0.92529,
    takeProfit: 0.92829,
    minRR: 1.5,
  });

  assert.equal(geometry.stopLossPips, 20);
  assert.equal(geometry.stopLoss, 0.92329);
  assert.ok(geometry.takeProfitPips >= 30);
  assert.ok(geometry.riskReward >= 1.5);
  assert.deepEqual(buildFixedStopLossOnFill({ pair: 'EUR_CHF' }), {
    distance: '0.00200',
    timeInForce: 'GTC',
  });
});


test('USD-quoted instruments need no broker conversion request in a USD account', async () => {
  const factor = await getLossQuoteHomeConversionFactor({
    pair: 'EUR_USD',
    client: { accountId: 'ACC-TEST' },
    homeCurrency: 'USD',
  });
  assert.equal(factor, 1);
});


test('broker quote-to-home loss factor keeps cross-pair planned loss at or below 1.25%', () => {
  const balanceUSD = 75689.5251;
  const targetRiskUSD = +(balanceUSD * 0.0125).toFixed(2);
  const sizing = computeFixedDollarSizing({
    pair: 'EUR_CHF',
    direction: 'long',
    entryPrice: 0.92529,
    targetRiskUSD,
    stopLossPips: 20,
    stopLossPrice: 0.92329,
    takeProfitPips: 60,
    takeProfitPrice: 0.93129,
    accountMarginRate: 0.02,
    accountBalanceUSD: balanceUSD,
    lossQuoteHomeConversionFactor: 1.24827745270636,
  });

  assert.ok(sizing.actualRiskUSD <= targetRiskUSD);
  assert.ok(sizing.actualRiskUSD > targetRiskUSD - 0.01);
  assert.equal(sizing.stopLossPips, 20);
  assert.ok(Math.abs(sizing.signedUnits) < 400000);
});
