import test from 'node:test';
import assert from 'node:assert/strict';
import { isIctAutoQualified } from './ictAutoTrade.js';

const cfg = { minConfidence: 80, minRR: 1.5 };

test('ICT Auto AI only attempts directional signals that satisfy confidence and R:R floors', () => {
  assert.equal(isIctAutoQualified({ signal: 'buy', confidence: 80, rr: 1.5 }, cfg), true);
  assert.equal(isIctAutoQualified({ signal: 'sell', confidence: 93, rr: 2.52 }, cfg), true);
  assert.equal(isIctAutoQualified({ signal: 'buy', confidence: 96, rr: 0.55 }, cfg), false);
  assert.equal(isIctAutoQualified({ signal: 'sell', confidence: 79, rr: 3.0 }, cfg), false);
  assert.equal(isIctAutoQualified({ signal: 'none', confidence: 99, rr: 5.0 }, cfg), false);
});
