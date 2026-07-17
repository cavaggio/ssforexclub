import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluatePrimaryTimeframeAlignment,
  PRIMARY_ALIGNMENT_POLICY_VERSION,
} from './primaryTimeframeAlignment.js';

test('Daily H4 and M15 aligned scores 100 and passes', () => {
  const result = evaluatePrimaryTimeframeAlignment({
    timeframes: {
      daily: 'bullish',
      h4: 'bullish',
      h1: 'bearish',
      m30: 'bearish',
      m15: 'bullish',
      m5: 'bearish',
    },
  }, 'long');

  assert.equal(result.passed, true);
  assert.equal(result.score, 100);
  assert.equal(result.dailyH4Aligned, true);
  assert.equal(result.m15Aligned, true);
  assert.equal(result.policyVersion, PRIMARY_ALIGNMENT_POLICY_VERSION);
  assert.deepEqual(result.hardTimeframes, ['daily', 'h4']);
  assert.deepEqual(result.primaryTimeframes, ['daily', 'h4', 'm15']);
  assert.deepEqual(result.fibOnlyTimeframes, ['h1']);
  assert.deepEqual(result.contextConflicts.sort(), ['m30', 'm5'].sort());
  assert.equal(Object.hasOwn(result.biases, 'h1'), false);
});

test('Daily and H4 aligned score exactly 67 and pass when M15 opposes', () => {
  const result = evaluatePrimaryTimeframeAlignment({
    timeframes: { daily: 'bullish', h4: 'bullish', m15: 'bearish' },
  }, 'long');

  assert.equal(result.passed, true);
  assert.equal(result.score, 67);
  assert.equal(result.dailyH4Aligned, true);
  assert.equal(result.m15Aligned, false);
  assert.deepEqual(result.alignedTimeframes.sort(), ['daily', 'h4']);
  assert.match(result.reason, /passed at 67\/100/);
});

test('Daily and H4 aligned remain 67 when M15 is neutral', () => {
  const result = evaluatePrimaryTimeframeAlignment({
    timeframes: { daily: 'bearish', h4: 'bearish', m15: 'neutral' },
  }, 'short');

  assert.equal(result.passed, true);
  assert.equal(result.score, 67);
  assert.equal(result.dailyH4Aligned, true);
  assert.equal(result.m15Aligned, false);
});

test('Daily and H4 are the minimum and remain 67 when M15 is unavailable', () => {
  const result = evaluatePrimaryTimeframeAlignment({
    timeframes: { daily: 'bullish', h4: 'bullish' },
  }, 'long');

  assert.equal(result.passed, true);
  assert.equal(result.score, 67);
  assert.equal(result.dailyH4Aligned, true);
  assert.equal(result.m15Aligned, false);
  assert.deepEqual(result.missingTimeframes, ['m15']);
  assert.deepEqual(result.missingHardTimeframes, []);
});

test('H1 never changes the alignment score or pass decision', () => {
  const bullishH1 = evaluatePrimaryTimeframeAlignment({
    timeframes: { daily: 'bullish', h4: 'bullish', h1: 'bullish', m15: 'bearish' },
  }, 'long');
  const bearishH1 = evaluatePrimaryTimeframeAlignment({
    timeframes: { daily: 'bullish', h4: 'bullish', h1: 'bearish', m15: 'bearish' },
  }, 'long');

  assert.equal(bullishH1.score, 67);
  assert.equal(bearishH1.score, 67);
  assert.equal(bullishH1.passed, true);
  assert.equal(bearishH1.passed, true);
  assert.deepEqual(bullishH1.contextConflicts, []);
  assert.deepEqual(bearishH1.contextConflicts, []);
});

test('Daily H4 disagreement hard rejects even when H4 and M15 align', () => {
  const result = evaluatePrimaryTimeframeAlignment({
    timeframes: { daily: 'bearish', h4: 'bullish', m15: 'bullish' },
  }, 'long');

  assert.equal(result.score, 67);
  assert.equal(result.dailyH4Aligned, false);
  assert.equal(result.passed, false);
  assert.match(result.reason, /Daily and H4 must both align/);
});

test('derived majority direction still hard rejects when Daily and H4 disagree', () => {
  const result = evaluatePrimaryTimeframeAlignment({
    timeframes: {
      daily: 'bullish',
      h4: 'bearish',
      m15: 'bullish',
    },
  });

  assert.equal(result.expected, 'bullish');
  assert.equal(result.explicitDirection, false);
  assert.equal(result.score, 67);
  assert.equal(result.dailyH4Aligned, false);
  assert.equal(result.passed, false);
  assert.match(result.reason, /Daily and H4 must both align/);
});

test('one aligned directional timeframe scores 33 and rejects', () => {
  const result = evaluatePrimaryTimeframeAlignment({
    timeframes: {
      daily: 'bearish',
      h4: 'bullish',
      m15: 'bearish',
    },
  }, 'long');

  assert.equal(result.passed, false);
  assert.equal(result.score, 33);
  assert.deepEqual(result.alignedTimeframes, ['h4']);
});

test('zero aligned directional timeframes scores 0 and rejects', () => {
  const result = evaluatePrimaryTimeframeAlignment({
    timeframes: {
      daily: 'bearish',
      h4: 'bearish',
      m15: 'bearish',
    },
  }, 'long');

  assert.equal(result.passed, false);
  assert.equal(result.score, 0);
});

test('missing Daily or H4 classification fails closed', () => {
  const result = evaluatePrimaryTimeframeAlignment({
    timeframes: {
      daily: 'bullish',
      m15: 'bullish',
    },
  }, 'long');

  assert.equal(result.passed, false);
  assert.equal(result.score, 0);
  assert.deepEqual(result.missingHardTimeframes, ['h4']);
});
