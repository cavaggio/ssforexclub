import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluatePrimaryTimeframeAlignment,
  PRIMARY_ALIGNMENT_POLICY_VERSION,
} from './primaryTimeframeAlignment.js';

test('3 of 3 aligned scores 100 and passes; context conflicts stay diagnostic', () => {
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
  assert.equal(result.policyVersion, PRIMARY_ALIGNMENT_POLICY_VERSION);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.contextConflicts.sort(), ['h1', 'm30', 'm5'].sort());
});

test('Daily and H4 aligned score 67 and pass when M15 opposes', () => {
  const result = evaluatePrimaryTimeframeAlignment({
    timeframes: { daily: 'bullish', h4: 'bullish', m15: 'bearish' },
  }, 'long');
  assert.equal(result.passed, true);
  assert.equal(result.score, 67);
  assert.equal(result.dailyH4Aligned, true);
  assert.deepEqual(result.alignedTimeframes.sort(), ['daily', 'h4']);
});

test('Daily/H4 disagreement hard-rejects even when H4 and M15 align', () => {
  const result = evaluatePrimaryTimeframeAlignment({
    timeframes: { daily: 'bearish', h4: 'bullish', m15: 'bullish' },
  }, 'long');
  assert.equal(result.score, 67);
  assert.equal(result.dailyH4Aligned, false);
  assert.equal(result.passed, false);
  assert.match(result.reason, /Daily and H4 must both align/);
});

test('derived majority direction still hard-rejects when Daily and H4 disagree', () => {
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

test('1 of 3 aligned scores 33 and rejects', () => {
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

test('0 of 3 aligned scores 0 and rejects', () => {
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

test('missing primary classification fails closed', () => {
  const result = evaluatePrimaryTimeframeAlignment({
    timeframes: {
      daily: 'bullish',
      h4: 'bullish',
    },
  }, 'long');

  assert.equal(result.passed, false);
  assert.equal(result.score, 0);
  assert.deepEqual(result.missingTimeframes, ['m15']);
});
