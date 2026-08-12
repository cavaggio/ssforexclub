import test from 'node:test';
import assert from 'node:assert/strict';
import { isIctAutoQualified } from './ictAutoTrade.js';

const cfg = { minConfidence: 93, minRR: 1.5 };
const qualified = (over = {}) => ({
  pair: 'EUR_USD',
  executionEligible: true,
  signal: 'buy',
  confidence: 93,
  rr: 1.5,
  freshImpulse: true,
  h1Transition: { ready: true, transitionId: 'bullish:2026-06-04T15:00:00Z' },
  ...over,
});

test('ICT Auto AI only attempts executable directional signals that satisfy the 93% confidence and R:R floors', () => {
  assert.equal(isIctAutoQualified(qualified({ confidence: 92, rr: 2.5 }), cfg), false);
  assert.equal(isIctAutoQualified(qualified(), cfg), true);
  assert.equal(isIctAutoQualified(qualified({ pair: 'GBP_USD', signal: 'sell', confidence: 96, rr: 2.52 }), cfg), true);
  assert.equal(isIctAutoQualified(qualified({ confidence: 96, rr: 0.55 }), cfg), false);
  assert.equal(isIctAutoQualified(qualified({ signal: 'none', confidence: 99, rr: 5.0 }), cfg), false);
});

test('confidence cannot qualify a late/missing H1 transition or stale lower-timeframe impulse', () => {
  assert.equal(isIctAutoQualified(qualified({
    confidence: 99,
    h1Transition: { ready: false, transitionId: null },
  }), cfg), false);
  assert.equal(isIctAutoQualified(qualified({ confidence: 99, freshImpulse: false }), cfg), false);
});

test('XAU/USD, US30 and US500 remain signal-only even with qualified ICT setups', () => {
  for (const pair of ['XAU_USD', 'US30_USD', 'SPX500_USD']) {
    assert.equal(isIctAutoQualified(qualified({ pair, executionEligible: false, confidence: 99, rr: 3 }), cfg), false);
  }
});
