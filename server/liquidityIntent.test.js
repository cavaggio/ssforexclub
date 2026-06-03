import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLiquidityIntent } from './liquidityIntent.js';

const pair = 'EUR_USD';
const currentPrice = 1.1;

// More / closer resting liquidity BELOW price (sell-side) than above.
function liquidityFixture() {
  return {
    pools: [
      { label: 'Previous Week High', kind: 'high', price: 1.11, source: 'PWH', distancePips: 100 },
      { label: 'Previous Day High', kind: 'high', price: 1.106, source: 'PDH', distancePips: 60 },
      { label: 'Equal Highs', kind: 'high', price: 1.103, source: 'EQH', distancePips: 30 },
      { label: 'Previous Day Low', kind: 'low', price: 1.095, source: 'PDL', distancePips: 50 },
      { label: 'Asian Session Low', kind: 'low', price: 1.098, source: 'ASIA_L', distancePips: 20 },
    ],
  };
}

test('liquidity intent: classifies resting stops above / below', () => {
  const r = analyzeLiquidityIntent({ pair, direction: 'short', currentPrice, liquidity: liquidityFixture(), atrPips: 20 });
  assert.equal(r.likelyStopsAbove.length, 3, 'three high pools above price');
  assert.equal(r.likelyStopsBelow.length, 2, 'two low pools below price');
  assert.ok(r.likelyStopsAbove.every((p) => p.side === 'buy-side' && p.price > currentPrice));
  assert.ok(r.likelyStopsBelow.every((p) => p.side === 'sell-side' && p.price < currentPrice));
});

test('liquidity intent: bias points to the heavier / closer liquidity (sell-side here)', () => {
  const r = analyzeLiquidityIntent({ pair, direction: 'short', currentPrice, liquidity: liquidityFixture(), atrPips: 20 });
  assert.equal(r.liquidityBias, 'bearish', 'closer sell-side liquidity draws price down');
  assert.ok(r.expectedLiquidityTarget, 'has an expected draw');
  assert.equal(r.expectedLiquidityTarget.source, 'ASIA_L', 'nearest major pool on the heavy side');
});

test('liquidity intent: trading toward the draw scores higher than trading away', () => {
  const liquidity = liquidityFixture();
  const short = analyzeLiquidityIntent({ pair, direction: 'short', currentPrice, liquidity, atrPips: 20 });
  const long = analyzeLiquidityIntent({ pair, direction: 'long', currentPrice, liquidity, atrPips: 20 });
  assert.ok(short.intentScore > long.intentScore, 'short (with the bearish draw) beats long (against it)');
});

test('liquidity intent: degrades gracefully with no pools', () => {
  const r = analyzeLiquidityIntent({ pair, direction: 'long', currentPrice, liquidity: { pools: [] }, atrPips: 20 });
  assert.deepEqual(r.likelyStopsAbove, []);
  assert.deepEqual(r.likelyStopsBelow, []);
  assert.equal(r.liquidityBias, 'neutral');
  assert.equal(r.expectedLiquidityTarget, null);
  assert.ok(typeof r.intentScore === 'number');
});
