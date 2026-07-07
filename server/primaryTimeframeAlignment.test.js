import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluatePrimaryTimeframeAlignment,
} from './primaryTimeframeAlignment.js';

test('valid long: Daily + H4 + M15 aligned; H1/M30/M5 conflicts are context only', () => {
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
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.contextConflicts.sort(), ['h1', 'm30', 'm5'].sort());
});

test('invalid long: Daily must align', () => {
  const result = evaluatePrimaryTimeframeAlignment({
    timeframes: {
      daily: 'bearish',
      h4: 'bullish',
      m15: 'bullish',
    },
  }, 'long');

  assert.equal(result.passed, false);
  assert.deepEqual(result.failures, ['daily']);
});

test('invalid long: H4 must align', () => {
  const result = evaluatePrimaryTimeframeAlignment({
    timeframes: {
      daily: 'bullish',
      h4: 'bearish',
      m15: 'bullish',
    },
  }, 'long');

  assert.equal(result.passed, false);
  assert.deepEqual(result.failures, ['h4']);
});

test('invalid long: M15 must align', () => {
  const result = evaluatePrimaryTimeframeAlignment({
    timeframes: {
      daily: 'bullish',
      h4: 'bullish',
      m15: 'bearish',
    },
  }, 'long');

  assert.equal(result.passed, false);
  assert.deepEqual(result.failures, ['m15']);
});
