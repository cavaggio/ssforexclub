import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLiquidityTargets } from './liquidityTargeting.js';

const pair = 'EUR_USD';

function liq(pools) { return { pools }; }

test('targeting: long with major pools → accepted, TP tiers set', () => {
  const r = computeLiquidityTargets({
    pair, direction: 'long', entryPrice: 1.1000, stopLossPips: 20,
    liquidity: liq([
      { label: 'Equal Highs', source: 'EQH', price: 1.1030 },         // +30 minor
      { label: 'Previous Day High', source: 'PDH', price: 1.1060 },   // +60 major
      { label: 'Previous Week High', source: 'PWH', price: 1.1100 },  // +100 major
    ]),
  });
  assert.equal(r.accepted, true);
  assert.equal(r.targetSource, 'liquidity');
  assert.ok(r.tp1.price > 1.1000 && r.tp3.price > r.tp1.price, 'tiers ascend above entry');
  assert.equal(r.remainingOpportunityPips, 30);
  assert.equal(r.expectedMovePotential, 100);
  assert.equal(r.tp3.source, 'PWH'); // furthest major
});

test('targeting: REJECTS when major level caps move before acceptable RR', () => {
  // Spec example: ~10p below major resistance but ~60p needed.
  const r = computeLiquidityTargets({
    pair, direction: 'long', entryPrice: 1.1000, stopLossPips: 40,
    liquidity: liq([
      { label: 'Previous Day High', source: 'PDH', price: 1.1010 }, // +10 major cap
    ]),
  });
  assert.equal(r.accepted, false);
  assert.match(r.rejectionReason, /Insufficient remaining opportunity/);
});

test('targeting: short picks pools below entry', () => {
  const r = computeLiquidityTargets({
    pair, direction: 'short', entryPrice: 1.1000, stopLossPips: 20,
    liquidity: liq([
      { label: 'Equal Lows', source: 'EQL', price: 1.0980 },       // -20 minor
      { label: 'Previous Day Low', source: 'PDL', price: 1.0950 }, // -50 major
    ]),
  });
  assert.equal(r.accepted, true);
  assert.ok(r.tp1.price < 1.1000, 'TP1 below entry for short');
  assert.equal(r.tp3.source, 'PDL');
  assert.equal(r.remainingOpportunityPips, 20);
});

test('targeting: ATR fallback when no pools in direction', () => {
  const r = computeLiquidityTargets({
    pair, direction: 'long', entryPrice: 1.1000, stopLossPips: 20,
    liquidity: liq([{ label: 'Previous Day Low', source: 'PDL', price: 1.0950 }]), // only below
    atrPips: 12,
  });
  assert.equal(r.targetSource, 'atr_fallback');
  assert.equal(r.accepted, true);
  assert.ok(r.tp3.pips > r.tp1.pips, 'ATR tiers ascend');
});

test('targeting: missing inputs degrade safely', () => {
  const r = computeLiquidityTargets({ pair });
  assert.equal(r.accepted, false);
  assert.equal(r.tp1, null);
});
