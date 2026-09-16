import test from 'node:test';
import assert from 'node:assert/strict';
import { isIctAutoQualified } from './ictAutoTrade.js';

const cfg = { minConfidence: 93, minRR: 1.5 };
const qualified = (over = {}) => ({
  pair: 'EUR_USD',
  executionEligible: true,
  signal: 'buy',
  confidence: 93,
  rr: 1.6,
  entryTimeframe: '5M',
  entryCandle: { triggerReady: true },
  freshImpulse: true,
  triggerAgeBars: 0,
  entryAuthorization: {
    ready: true,
    mode: 'initial_reversal_mss',
    cycleId: '2026-06-04:EUR_USD:bullish:h4_fvg:initial',
    family: 'reversal',
    strategy: 'reversal',
    requiresMarketMakerActive: true,
  },
  marketMakerModel: {
    studyReady: true,
    stage: 'DISTRIBUTION_ACTIVE',
    keyLevelTap: { aligned: true },
    cycle: {
      keyLevel: { tappedAt: '2026-06-04T06:30:00Z' },
      manipulation: { time: '2026-06-04T06:35:00Z' },
      displacement: { time: '2026-06-04T06:40:00Z' },
    },
    observation: {
      sweepAligned: true,
      displacementFresh: true,
      mssAligned: true,
    },
  },
  concepts: { mss: { confirmed: true } },
  correctiveGate: { passed: true, decision: 'authorize', family: 'reversal', failureCodes: [] },
  ...over,
});

const continuation = (over = {}) => qualified({
  pair: 'GBP_JPY',
  signal: 'sell',
  entryAuthorization: {
    ready: true,
    mode: 'm5_continuation_breakout',
    cycleId: '2026-06-04:GBP_JPY:bearish:activated:m5-breakout',
    family: 'continuation',
    strategy: 'market_maker_continuation',
    requiresMarketMakerActive: true,
  },
  correctiveGate: { passed: true, decision: 'authorize', family: 'continuation', failureCodes: [] },
  timeframeBias: { d1: 'bearish', h4: 'bearish', d1H4Aligned: true },
  h1Momentum: {
    aligned: true,
    activeAligned: true,
    currentAligned: true,
    currentOpposing: false,
    exhausted: false,
  },
  continuationBreakout: {
    ready: true,
    retestConfirmed: true,
    mode: 'm5_continuation_breakout',
    cycleId: 'bearish:m5_continuation_breakout:1.1:2026-06-04T15:00:00Z',
  },
  ...over,
});

test('ICT Auto AI only attempts A-grade executable signals that satisfy confidence and R:R floors', () => {
  assert.equal(isIctAutoQualified(qualified({ confidence: 92, rr: 2.5 }), cfg), false);
  assert.equal(isIctAutoQualified(qualified(), cfg), true);
  assert.equal(isIctAutoQualified(qualified({ pair: 'GBP_USD', signal: 'sell', confidence: 96, rr: 2.52 }), cfg), true);
  assert.equal(isIctAutoQualified(qualified({ confidence: 96, rr: 0.55 }), cfg), false);
  assert.equal(isIctAutoQualified(qualified({ signal: 'none', confidence: 99, rr: 5.0 }), cfg), false);
});

test('confidence cannot bypass strategy authorization, current-day study, or stale lower-timeframe impulse', () => {
  assert.equal(isIctAutoQualified(qualified({
    confidence: 99,
    entryAuthorization: { ready: false, cycleId: null },
  }), cfg), false);
  assert.equal(isIctAutoQualified(qualified({
    confidence: 99,
    marketMakerModel: { studyReady: false, stage: null },
  }), cfg), false);
  assert.equal(isIctAutoQualified(qualified({ confidence: 99, freshImpulse: false }), cfg), false);
  assert.equal(isIctAutoQualified(qualified({ confidence: 99, triggerAgeBars: 2 }), cfg), false);
  assert.equal(isIctAutoQualified(qualified({ confidence: 99, entryTimeframe: '15M' }), cfg), false);
  assert.equal(isIctAutoQualified(qualified({ confidence: 99, entryCandle: { triggerReady: false } }), cfg), false);
  assert.equal(isIctAutoQualified(qualified({ confidence: 99, correctiveGate: { passed: false, decision: 'reject' } }), cfg), false);
});

test('continuation also requires an activated DISTRIBUTION_ACTIVE parent cycle', () => {
  assert.equal(isIctAutoQualified(continuation({
    marketMakerModel: { studyReady: true, stage: 'HTF_KEY_TAPPED' },
  }), cfg), false);
});

test('PO3-dependent reversal remains blocked until DISTRIBUTION_ACTIVE', () => {
  assert.equal(isIctAutoQualified(qualified({
    marketMakerModel: { studyReady: true, stage: 'HTF_KEY_TAPPED' },
  }), cfg), false);
});

test('an activated parent cycle can authorize a fresh A-grade M5 continuation entry', () => {
  assert.equal(isIctAutoQualified(continuation(), cfg), true);
});

test('XAU/USD, US30 and US500 remain signal-only even with otherwise A-grade ICT setups', () => {
  for (const pair of ['XAU_USD', 'US30_USD', 'SPX500_USD']) {
    assert.equal(isIctAutoQualified(qualified({ pair, executionEligible: false, confidence: 99, rr: 3 }), cfg), false);
  }
});
