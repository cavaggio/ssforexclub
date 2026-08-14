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
  entryTimeframe: '5M',
  entryCandle: { triggerReady: true },
  freshImpulse: true,
  entryAuthorization: {
    ready: true,
    mode: 'initial_reversal_mss',
    cycleId: '2026-06-04:EUR_USD:bullish:h4_fvg:initial',
  },
  marketMakerModel: { studyReady: true, stage: 'DISTRIBUTION_ACTIVE' },
  ...over,
});

test('ICT Auto AI only attempts executable directional signals that satisfy the 93% confidence and R:R floors', () => {
  assert.equal(isIctAutoQualified(qualified({ confidence: 92, rr: 2.5 }), cfg), false);
  assert.equal(isIctAutoQualified(qualified(), cfg), true);
  assert.equal(isIctAutoQualified(qualified({ pair: 'GBP_USD', signal: 'sell', confidence: 96, rr: 2.52 }), cfg), true);
  assert.equal(isIctAutoQualified(qualified({ confidence: 96, rr: 0.55 }), cfg), false);
  assert.equal(isIctAutoQualified(qualified({ signal: 'none', confidence: 99, rr: 5.0 }), cfg), false);
});

test('confidence cannot bypass the central market-maker authorization or stale lower-timeframe impulse', () => {
  assert.equal(isIctAutoQualified(qualified({
    confidence: 99,
    entryAuthorization: { ready: false, cycleId: null },
  }), cfg), false);
  assert.equal(isIctAutoQualified(qualified({
    confidence: 99,
    marketMakerModel: { studyReady: false, stage: null },
  }), cfg), false);
  assert.equal(isIctAutoQualified(qualified({ confidence: 99, freshImpulse: false }), cfg), false);
  assert.equal(isIctAutoQualified(qualified({ confidence: 99, entryTimeframe: '15M' }), cfg), false);
  assert.equal(isIctAutoQualified(qualified({ confidence: 99, entryCandle: { triggerReady: false } }), cfg), false);
});

test('an activated parent cycle can authorize a fresh M5 continuation entry', () => {
  assert.equal(isIctAutoQualified(qualified({
    continuationBreakout: {
      ready: true,
      mode: 'm5_continuation_breakout',
      cycleId: 'bullish:m5_continuation_breakout:1.1:2026-06-04T15:00:00Z',
    },
    entryAuthorization: {
      ready: true,
      mode: 'm5_continuation_breakout',
      cycleId: '2026-06-04:EUR_USD:bullish:activated:m5-breakout',
    },
  }), cfg), true);
});

test('XAU/USD, US30 and US500 remain signal-only even with qualified ICT setups', () => {
  for (const pair of ['XAU_USD', 'US30_USD', 'SPX500_USD']) {
    assert.equal(isIctAutoQualified(qualified({ pair, executionEligible: false, confidence: 99, rr: 3 }), cfg), false);
  }
});
