import test from 'node:test';
import assert from 'node:assert/strict';
import { isIctAutoQualified } from './ictAutoTrade.js';

const cfg = { minConfidence: 93, minRR: 1.5 };

test('ICT Auto AI only attempts executable directional signals that satisfy the 93% confidence and R:R floors', () => {
  assert.equal(isIctAutoQualified({ pair: 'EUR_USD', signal: 'buy', confidence: 92, rr: 2.5 }, cfg), false);
  assert.equal(isIctAutoQualified({ pair: 'EUR_USD', signal: 'buy', confidence: 93, rr: 1.5 }, cfg), true);
  assert.equal(isIctAutoQualified({ pair: 'GBP_USD', signal: 'sell', confidence: 96, rr: 2.52 }, cfg), true);
  assert.equal(isIctAutoQualified({ pair: 'EUR_USD', signal: 'buy', confidence: 96, rr: 0.55 }, cfg), false);
  assert.equal(isIctAutoQualified({ pair: 'EUR_USD', signal: 'none', confidence: 99, rr: 5.0 }, cfg), false);
});

test('XAU/USD, US30 and US500 remain signal-only even with qualified ICT setups', () => {
  for (const pair of ['XAU_USD', 'US30_USD', 'SPX500_USD']) {
    assert.equal(isIctAutoQualified({
      pair,
      executionEligible: false,
      signal: 'buy',
      confidence: 99,
      rr: 3,
    }, cfg), false);
  }
});
