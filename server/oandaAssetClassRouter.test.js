import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateForexDirectionalConsensus,
  qualifyForexSignal,
} from './oandaAssetClassRouter.js';

test('blocks a long when Daily, H4, H1, M15 structures are bearish', () => {
  const ctx = {
    direction: 'long',
    macro: { dailyTrend: 'bearish', h4Trend: 'bearish' },
    structure: { h1Trend: 'bearish', m30Trend: 'bearish' },
    momentum: { m15Trend: 'bearish', m5Trend: 'bearish' },
    mtfAuthority: {
      higherTimeframeBias: 'bearish',
      confirmationTimeframeBias: 'bearish',
      entryTimeframeBias: 'bearish',
      conflict: true,
    },
  };

  const result = qualifyForexSignal(ctx);
  assert.equal(result.accepted, false);
  assert.match(result.rejectionReasons[0], /Directional risk cap/i);
  assert.equal(result.classSpecific.directionalConsensus.h4H1Oppose, true);
});

test('blocks a short when primary structure consensus is bullish', () => {
  const result = evaluateForexDirectionalConsensus({
    direction: 'short',
    macro: { dailyTrend: 'bullish', h4Trend: 'bullish' },
    structure: { h1Trend: 'mixed' },
    momentum: { m15Trend: 'bullish' },
  });

  assert.equal(result.accepted, false);
  assert.equal(result.primaryConsensusOpposes, true);
});

test('allows a long when H4, H1 and M15 align bullish', () => {
  const result = evaluateForexDirectionalConsensus({
    direction: 'long',
    macro: { dailyTrend: 'neutral', h4Trend: 'bullish' },
    structure: { h1Trend: 'bullish', m30Trend: 'bullish' },
    momentum: { m15Trend: 'bullish', m5Trend: 'bullish' },
    mtfAuthority: {
      higherTimeframeBias: 'bullish',
      confirmationTimeframeBias: 'bullish',
      entryTimeframeBias: 'bullish',
      conflict: false,
    },
  });

  assert.equal(result.accepted, true);
  assert.deepEqual(result.opposed, []);
});

test('does not fail closed solely because structure data is missing', () => {
  const result = evaluateForexDirectionalConsensus({ direction: 'long' });
  assert.equal(result.accepted, true);
  assert.match(result.reason, /No explicit countertrend/i);
});
