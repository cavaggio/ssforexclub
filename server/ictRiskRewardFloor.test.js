import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ICT_MIN_RR, enforceMinimumRRTarget } from './ictEngine.js';

test('ICT target floor extends a low-RR long setup to 1.5R', () => {
  assert.equal(ICT_MIN_RR, 1.5);

  const result = enforceMinimumRRTarget({
    pair: 'USD_CHF',
    direction: 'long',
    entry: 0.81244,
    stopLoss: 0.81184,
    target: 0.81290,
    minRR: 1.5,
  });

  assert.equal(result.ok, true);
  assert.equal(result.target, 0.81334);
  assert.equal(result.rr, 1.5);
  assert.equal(result.adjusted, true);
});

test('ICT target floor extends a low-RR short setup to 1.5R', () => {
  const result = enforceMinimumRRTarget({
    pair: 'EUR_USD',
    direction: 'short',
    entry: 1.10000,
    stopLoss: 1.10100,
    target: 1.09950,
    minRR: 1.5,
  });

  assert.equal(result.ok, true);
  assert.equal(result.target, 1.09850);
  assert.equal(result.rr, 1.5);
  assert.equal(result.adjusted, true);
});

test('ICT target floor preserves a natural target already above 1.5R', () => {
  const result = enforceMinimumRRTarget({
    pair: 'EUR_USD',
    direction: 'long',
    entry: 1.10000,
    stopLoss: 1.09900,
    target: 1.10200,
    minRR: 1.5,
  });

  assert.equal(result.ok, true);
  assert.equal(result.target, 1.10200);
  assert.equal(result.rr, 2);
  assert.equal(result.adjusted, false);
});

test('ICT target floor remains valid after instrument price rounding', () => {
  const result = enforceMinimumRRTarget({
    pair: 'XAU_USD',
    direction: 'long',
    entry: 2400.00,
    stopLoss: 2399.99,
    target: 2400.01,
    minRR: 1.5,
  });

  assert.equal(result.ok, true);
  assert.ok(result.rr >= 1.5);
  assert.ok(result.target > 2400.01);
});
