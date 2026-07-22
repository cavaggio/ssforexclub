import test from 'node:test';
import assert from 'node:assert/strict';
import { isIctAutoQualified } from './ictAutoTrade.js';

const cfg = { minConfidence: 93, minRR: 1.5 };

test('ICT Auto AI only attempts directional signals that satisfy the 93% confidence and R:R floors', () => {
  assert.equal(isIctAutoQualified({ signal: 'buy', confidence: 92, rr: 2.5 }, cfg), false);
  assert.equal(isIctAutoQualified({ signal: 'buy', confidence: 93, rr: 1.5 }, cfg), true);
  assert.equal(isIctAutoQualified({ signal: 'sell', confidence: 96, rr: 2.52 }, cfg), true);
  assert.equal(isIctAutoQualified({ signal: 'buy', confidence: 96, rr: 0.55 }, cfg), false);
  assert.equal(isIctAutoQualified({ signal: 'none', confidence: 99, rr: 5.0 }, cfg), false);
});
