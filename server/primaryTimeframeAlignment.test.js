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

test('2 of 3 aligned scores exactly 67 and passes with one opposing timeframe', () => {
  const result = evaluatePrimaryTimeframeAlignment({
    timeframes: {
      daily: 'bearish',
      h4: 'bullish',
      m15: 'bullish',
    },
  }, 'long');

  assert.equal(result.passed, true);
  assert.equal(result.score, 67);
  assert.deepEqual(result.alignedTimeframes.sort(), ['h4', 'm15']);
  assert.deepEqual(result.opposingTimeframes, ['daily']);
  assert.match(result.reason, /diagnostic only/i);
});

test('2 of 3 can derive direction when the legacy macro direction is ranging', () => {
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
  assert.equal(result.passed, true);
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
