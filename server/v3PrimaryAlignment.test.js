import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateV3PrimaryAlignment,
  V3_PRIMARY_ALIGNMENT_MIN_SCORE,
} from './v3PrimaryAlignment.js';

test('3 of 3 aligned scores 100 and passes', () => {
  const result = evaluateV3PrimaryAlignment({
    direction: 'long',
    dailyTrend: 'bullish',
    h4Trend: 'bullish',
    m15Trend: 'bullish',
  });

  assert.equal(result.score, 100);
  assert.equal(result.passed, true);
  assert.deepEqual(result.opposingTimeframes, []);
});

test('2 of 3 aligned scores 67 and one opposing timeframe is diagnostic only', () => {
  const result = evaluateV3PrimaryAlignment({
    direction: 'long',
    dailyTrend: 'bullish',
    h4Trend: 'bullish',
    m15Trend: 'bearish',
  });

  assert.equal(V3_PRIMARY_ALIGNMENT_MIN_SCORE, 67);
  assert.equal(result.score, 67);
  assert.equal(result.passed, true);
  assert.deepEqual(result.opposingTimeframes, ['m15']);
  assert.match(result.diagnostic, /m15 opposes/i);
});

test('1 of 3 aligned scores 33 and rejects', () => {
  const result = evaluateV3PrimaryAlignment({
    direction: 'short',
    dailyTrend: 'bullish',
    h4Trend: 'bearish',
    m15Trend: 'bullish',
  });

  assert.equal(result.score, 33);
  assert.equal(result.passed, false);
  assert.match(result.reason, /33\/100 < 67\/100/);
});

test('0 of 3 aligned scores 0 and rejects', () => {
  const result = evaluateV3PrimaryAlignment({
    direction: 'short',
    dailyTrend: 'bullish',
    h4Trend: 'bullish',
    m15Trend: 'bullish',
  });

  assert.equal(result.score, 0);
  assert.equal(result.passed, false);
});

test('missing primary timeframe data fails closed', () => {
  const result = evaluateV3PrimaryAlignment({
    direction: 'long',
    dailyTrend: 'bullish',
    h4Trend: null,
    m15Trend: 'bullish',
  });

  assert.equal(result.passed, false);
  assert.equal(result.status, 'insufficient_data');
  assert.deepEqual(result.missingTimeframes, ['h4']);
});
