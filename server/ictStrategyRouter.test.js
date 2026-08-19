import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveIctStrategyAuthorization } from './ictStrategyRouter.js';

const bullishMomentum = {
  aligned: true,
  activeAligned: true,
  exhausted: false,
  reason: 'Completed H1 momentum is actively bullish.',
};

const continuation = {
  ready: true,
  mode: 'm5_continuation_breakout',
  cycleId: 'bullish:m5_continuation_breakout:1.1600:2026-08-19T07:10:00Z',
  reason: 'Fresh bullish M5 displacement breakout.',
};

const early = {
  availableCount: 3,
  completedCount: 3,
  direction: 'bullish',
  alignedWithBias: true,
  provisional: false,
};

test('direct continuation can authorize while PO3 is only HTF_KEY_TAPPED', () => {
  const result = resolveIctStrategyAuthorization({
    direction: 'bullish',
    htfAligned: true,
    h1Momentum: bullishMomentum,
    continuationBreakout: continuation,
    earlySessionDirection: early,
    marketMakerResolution: {
      cycle: { stage: 'HTF_KEY_TAPPED' },
      entryAuthorization: {
        ready: false,
        mode: 'none',
        cycleId: null,
        reason: 'Market-maker cycle is HTF_KEY_TAPPED; waiting for the next required stage.',
      },
    },
  });

  assert.equal(result.entryAuthorization.ready, true);
  assert.equal(result.entryAuthorization.family, 'continuation');
  assert.equal(result.entryAuthorization.strategy, 'continuation_breakout');
  assert.equal(result.entryAuthorization.requiresMarketMakerActive, false);
  assert.match(result.entryAuthorization.reason, /independently of the PO3 reversal cycle/);
});

test('complete initial reversal takes priority when both models are valid', () => {
  const result = resolveIctStrategyAuthorization({
    direction: 'bullish',
    htfAligned: true,
    h1Momentum: bullishMomentum,
    continuationBreakout: continuation,
    earlySessionDirection: early,
    marketMakerResolution: {
      cycle: { stage: 'DISTRIBUTION_ACTIVE' },
      entryAuthorization: {
        ready: true,
        mode: 'initial_reversal_mss',
        cycleId: 'reversal-1',
        reason: 'Complete reversal sequence activated distribution.',
      },
    },
  });

  assert.equal(result.entryAuthorization.strategy, 'reversal');
  assert.equal(result.entryAuthorization.family, 'reversal');
  assert.equal(result.entryAuthorization.requiresMarketMakerActive, true);
});

test('continuation still rejects when H1 active momentum is not aligned', () => {
  const result = resolveIctStrategyAuthorization({
    direction: 'bullish',
    htfAligned: true,
    h1Momentum: {
      aligned: false,
      activeAligned: false,
      exhausted: true,
      reason: 'H1 momentum is exhausted.',
    },
    continuationBreakout: continuation,
    marketMakerResolution: {
      entryAuthorization: { ready: false, mode: 'none', cycleId: null, reason: 'Reversal not ready.' },
    },
  });

  assert.equal(result.entryAuthorization.ready, false);
  assert.match(result.entryAuthorization.reason, /H1 momentum is exhausted/);
});

test('market-maker continuation remains available as its own strategy path', () => {
  const result = resolveIctStrategyAuthorization({
    direction: 'bullish',
    htfAligned: true,
    h1Momentum: bullishMomentum,
    continuationBreakout: { ready: false, reason: 'No direct breakout.' },
    marketMakerResolution: {
      cycle: { stage: 'DISTRIBUTION_ACTIVE' },
      entryAuthorization: {
        ready: true,
        mode: 'm5_continuation_cisd',
        cycleId: 'mm-cont-1',
        reason: 'Active distribution CISD continuation.',
      },
    },
  });

  assert.equal(result.entryAuthorization.ready, true);
  assert.equal(result.entryAuthorization.strategy, 'market_maker_continuation');
  assert.equal(result.entryAuthorization.family, 'continuation');
  assert.equal(result.entryAuthorization.requiresMarketMakerActive, true);
});
