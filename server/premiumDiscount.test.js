import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzePremiumDiscount } from './premiumDiscount.js';

const pair = 'EUR_USD';
// Swing 1.1000 → 1.1100. Equilibrium 1.1050. 0% at low, 100% at high.
const fib = { swingHigh: 1.11, swingLow: 1.1 };

test('premium/discount: long in discount scores high with no penalty', () => {
  const r = analyzePremiumDiscount({ pair, direction: 'long', currentPrice: 1.102, fib });
  assert.equal(r.enabled, true);
  assert.equal(r.premiumDiscountState, 'discount');
  assert.equal(r.entryQualityPenalty, 0);
  assert.ok(r.premiumDiscountScore >= 0.9);
  assert.ok(r.pricePositionPct < 0.45);
});

test('premium/discount: long in premium is penalised', () => {
  const r = analyzePremiumDiscount({ pair, direction: 'long', currentPrice: 1.109, fib });
  assert.equal(r.premiumDiscountState, 'premium');
  assert.ok(r.entryQualityPenalty > 0, 'buying premium is penalised');
  assert.ok(r.premiumDiscountScore < 0.5);
});

test('premium/discount: short in premium scores high', () => {
  const r = analyzePremiumDiscount({ pair, direction: 'short', currentPrice: 1.109, fib });
  assert.equal(r.premiumDiscountState, 'premium');
  assert.equal(r.entryQualityPenalty, 0);
  assert.ok(r.premiumDiscountScore >= 0.9);
});

test('premium/discount: short in discount is penalised', () => {
  const r = analyzePremiumDiscount({ pair, direction: 'short', currentPrice: 1.101, fib });
  assert.equal(r.premiumDiscountState, 'discount');
  assert.ok(r.entryQualityPenalty > 0, 'selling discount is penalised');
});

test('premium/discount: equilibrium band is neutral-ish', () => {
  const r = analyzePremiumDiscount({ pair, direction: 'long', currentPrice: 1.105, fib });
  assert.equal(r.premiumDiscountState, 'equilibrium');
  assert.equal(r.entryQualityPenalty, 0);
});

test('premium/discount: missing fib swing → neutral, never penalises', () => {
  const noImpulse = analyzePremiumDiscount({ pair, direction: 'long', currentPrice: 1.105, fib: { enabled: true, entryZoneStatus: 'unknown' } });
  assert.equal(noImpulse.enabled, false);
  assert.equal(noImpulse.premiumDiscountState, 'unknown');
  assert.equal(noImpulse.premiumDiscountScore, 0.5);
  assert.equal(noImpulse.entryQualityPenalty, 0);

  const noDir = analyzePremiumDiscount({ pair, direction: null, currentPrice: 1.105, fib });
  assert.equal(noDir.enabled, false);
  assert.equal(noDir.entryQualityPenalty, 0);
});

test('premium/discount: price beyond the swing clamps to 0..1', () => {
  const above = analyzePremiumDiscount({ pair, direction: 'long', currentPrice: 1.120, fib });
  assert.equal(above.pricePositionPct, 1);
  const below = analyzePremiumDiscount({ pair, direction: 'short', currentPrice: 1.090, fib });
  assert.equal(below.pricePositionPct, 0);
});
