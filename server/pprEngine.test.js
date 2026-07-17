import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyPprDailyBias,
  detectPprFvgMitigation,
  detectPprLiquidityRaid,
  detectPprOrderBlockRetest,
  detectPprVolumeSpike,
  findPprSwingPools,
  pprSession,
  selectPprLiquidityTarget,
} from './pprEngine.js';

function candle({ open, high, low, close, volume = 100, time = '2026-07-14T08:00:00.000Z' }) {
  return { open, high, low, close, volume, time };
}

test('PPR Daily EMA bias requires aligned price, EMA order, and slope', () => {
  const bullish = Array.from({ length: 120 }, (_, index) => {
    const close = 1.05 + index * 0.001;
    return candle({ open: close - 0.0005, high: close + 0.001, low: close - 0.001, close });
  });
  const bearish = Array.from({ length: 120 }, (_, index) => {
    const close = 1.25 - index * 0.001;
    return candle({ open: close + 0.0005, high: close + 0.001, low: close - 0.001, close });
  });

  assert.equal(classifyPprDailyBias(bullish).bias, 'bullish');
  assert.equal(classifyPprDailyBias(bearish).bias, 'bearish');
});

test('PPR identifies swing liquidity and selects the nearest directional target', () => {
  const candles = [
    candle({ open: 1.10, high: 1.11, low: 1.09, close: 1.10 }),
    candle({ open: 1.10, high: 1.13, low: 1.095, close: 1.12 }),
    candle({ open: 1.12, high: 1.115, low: 1.08, close: 1.09 }),
    candle({ open: 1.09, high: 1.12, low: 1.085, close: 1.11 }),
    candle({ open: 1.11, high: 1.10, low: 1.07, close: 1.08 }),
  ];
  const pools = findPprSwingPools(candles, 1);
  assert.ok(pools.highs.some((pool) => pool.price === 1.13));
  assert.ok(pools.lows.some((pool) => pool.price === 1.08));
  assert.equal(selectPprLiquidityTarget({ pools, direction: 'long', entry: 1.10 })?.price, 1.12);
});

test('PPR volume spike uses current OANDA tick volume against prior baseline', () => {
  const candles = Array.from({ length: 21 }, (_, index) => candle({
    open: 1,
    high: 1.01,
    low: 0.99,
    close: 1,
    volume: index === 20 ? 180 : 100,
  }));
  const result = detectPprVolumeSpike(candles, { volumeLookback: 20, volumeSpikeMultiplier: 1.5 });
  assert.equal(result.detected, true);
  assert.equal(Number(result.ratio.toFixed(2)), 1.8);
});

test('PPR confirms a bullish sell-side liquidity raid only after reclaim', () => {
  const pools = { highs: [], lows: [{ price: 1.1, time: 'prior' }] };
  const candles = [
    candle({ open: 1.105, high: 1.108, low: 1.102, close: 1.104 }),
    candle({ open: 1.104, high: 1.106, low: 1.095, close: 1.099 }),
    candle({ open: 1.099, high: 1.108, low: 1.094, close: 1.106 }),
  ];
  const raid = detectPprLiquidityRaid({ candles, pools, direction: 'long' });
  assert.equal(raid?.subtype, 'sell_side_stop_hunt');
  assert.equal(raid?.direction, 'bullish');
});

test('PPR recognizes bullish FVG mitigation with directional rejection', () => {
  const candles = [
    candle({ open: 1.09, high: 1.10, low: 1.08, close: 1.095 }),
    candle({ open: 1.10, high: 1.13, low: 1.099, close: 1.125 }),
    candle({ open: 1.12, high: 1.14, low: 1.11, close: 1.135 }),
    candle({ open: 1.13, high: 1.15, low: 1.12, close: 1.14 }),
    candle({ open: 1.14, high: 1.15, low: 1.13, close: 1.145 }),
    candle({ open: 1.145, high: 1.15, low: 1.135, close: 1.14 }),
    candle({ open: 1.14, high: 1.145, low: 1.105, close: 1.13 }),
    candle({ open: 1.115, high: 1.135, low: 1.105, close: 1.13 }),
  ];
  const fvg = detectPprFvgMitigation({ candles, direction: 'long' });
  assert.equal(fvg?.type, 'fvg_mitigation');
  assert.equal(fvg?.direction, 'bullish');
});

test('PPR recognizes an order-block retest after ATR-sized displacement', () => {
  const candles = [
    candle({ open: 1.10, high: 1.102, low: 1.098, close: 1.101 }),
    candle({ open: 1.101, high: 1.103, low: 1.097, close: 1.098 }),
    candle({ open: 1.098, high: 1.113, low: 1.097, close: 1.112 }),
    candle({ open: 1.112, high: 1.116, low: 1.108, close: 1.114 }),
    candle({ open: 1.114, high: 1.118, low: 1.11, close: 1.116 }),
    candle({ open: 1.116, high: 1.119, low: 1.112, close: 1.115 }),
    candle({ open: 1.115, high: 1.118, low: 1.11, close: 1.113 }),
    candle({ open: 1.113, high: 1.116, low: 1.108, close: 1.11 }),
    candle({ open: 1.10, high: 1.107, low: 1.097, close: 1.105 }),
    candle({ open: 1.105, high: 1.108, low: 1.1, close: 1.107 }),
  ];
  const block = detectPprOrderBlockRetest({ candles, direction: 'long', atrValue: 0.008 });
  assert.equal(block?.type, 'order_block_retest');
});

test('PPR session is 02:00 inclusive to 10:00 exclusive ET on weekdays', () => {
  assert.equal(pprSession(new Date('2026-07-14T06:00:00Z')).allowed, true); // 02:00 ET Tue
  assert.equal(pprSession(new Date('2026-07-14T13:59:00Z')).allowed, true); // 09:59 ET Tue
  assert.equal(pprSession(new Date('2026-07-14T14:00:00Z')).allowed, false); // 10:00 ET Tue
  assert.equal(pprSession(new Date('2026-07-18T08:00:00Z')).allowed, false); // Saturday
});
