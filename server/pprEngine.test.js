import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPprLiquidityPools,
  classifyPprDailyBias,
  classifyPprH1Alignment,
  combinePprManipulations,
  detectPprFvgMitigation,
  detectPprLiquidityRaid,
  detectPprOrderBlockRetest,
  detectPprVolumeSpike,
  getPprWatchlist,
  pprSession,
  selectPprLiquidityTarget,
} from './pprEngine.js';

function candle({
  open,
  high,
  low,
  close,
  volume = 100,
  time = '2026-07-14T08:00:00.000Z',
}) {
  return { open, high, low, close, volume, time };
}

function trendingCandles({ start, step, count = 40, intervalMs = 3600000 }) {
  return Array.from({ length: count }, (_, index) => {
    const close = start + step * index;
    return candle({
      open: close - Math.sign(step || 1) * 0.0005,
      high: close + 0.001,
      low: close - 0.001,
      close,
      time: new Date(Date.parse('2026-07-01T00:00:00.000Z') + index * intervalMs).toISOString(),
    });
  });
}

test('PPR fixed watchlist contains only GBP_JPY, EUR_GBP and GBP_USD', () => {
  const prior = process.env.PPR_FOREX_WATCHLIST;
  process.env.PPR_FOREX_WATCHLIST = 'EUR_USD,GBP_JPY,EUR_GBP,GBP_USD';
  assert.deepEqual(getPprWatchlist(), ['GBP_JPY', 'EUR_GBP', 'GBP_USD']);
  if (prior === undefined) delete process.env.PPR_FOREX_WATCHLIST;
  else process.env.PPR_FOREX_WATCHLIST = prior;
});

test('PPR Daily bias uses EMA9 only with aligned slope', () => {
  const bullish = trendingCandles({ start: 1.05, step: 0.001, count: 40, intervalMs: 86400000 });
  const bearish = trendingCandles({ start: 1.25, step: -0.001, count: 40, intervalMs: 86400000 });
  const bullishResult = classifyPprDailyBias(bullish);
  const bearishResult = classifyPprDailyBias(bearish);
  assert.equal(bullishResult.bias, 'bullish');
  assert.equal(bearishResult.bias, 'bearish');
  assert.match(bullishResult.reason, /EMA9/);
  assert.equal('slowEma' in bullishResult, false);
});

test('PPR execution alignment requires H1 price on the EMA9 bias side', () => {
  const bullish = trendingCandles({ start: 1.05, step: 0.001, count: 30 });
  assert.equal(classifyPprH1Alignment(bullish, 'long').aligned, true);
  assert.equal(classifyPprH1Alignment(bullish, 'short').aligned, false);
});

test('PPR clusters interchangeable liquidity sources and records overlap', () => {
  const h1 = [
    candle({ open: 1.10, high: 1.11, low: 1.09, close: 1.10, time: '2026-07-13T13:00:00Z' }),
    candle({ open: 1.10, high: 1.13, low: 1.095, close: 1.12, time: '2026-07-13T14:00:00Z' }),
    candle({ open: 1.12, high: 1.115, low: 1.08, close: 1.09, time: '2026-07-13T15:00:00Z' }),
    candle({ open: 1.09, high: 1.1299, low: 1.085, close: 1.11, time: '2026-07-13T16:00:00Z' }),
    candle({ open: 1.11, high: 1.10, low: 1.07, close: 1.08, time: '2026-07-13T17:00:00Z' }),
  ];
  const m15 = h1.map((item, index) => ({ ...item, time: new Date(Date.parse(item.time) + index * 900000).toISOString() }));
  const daily = trendingCandles({ start: 1.0, step: 0.001, count: 15, intervalMs: 86400000 });
  const pools = buildPprLiquidityPools({
    pair: 'GBP_USD',
    daily,
    h1,
    m15,
    now: new Date('2026-07-14T13:00:00Z'),
    config: {
      swingLookback: 1,
      poolClusterTolerancePips: 2,
    },
  });
  const overlappingHigh = pools.highs.find((pool) => pool.touchCount >= 2);
  assert.ok(overlappingHigh);
  assert.equal(overlappingHigh.overlapping, true);
  assert.ok(overlappingHigh.sources.includes('equal_highs'));
});

test('PPR target selection has no fixed source hierarchy and chooses nearest cluster preserving minimum R:R', () => {
  const pools = {
    highs: [
      { price: 1.105, sources: ['previous_day_high'], confluenceScore: 4 },
      { price: 1.12, sources: ['h1_swing_high', 'equal_highs'], confluenceScore: 3 },
      { price: 1.13, sources: ['previous_week_high'], confluenceScore: 1 },
    ],
    lows: [],
  };
  const target = selectPprLiquidityTarget({
    pools,
    direction: 'long',
    entry: 1.10,
    stopLoss: 1.095,
    minRR: 1.5,
  });
  assert.equal(target.price, 1.12);
  assert.equal(target.sources.includes('h1_swing_high'), true);
  assert.match(target.selectionReason, /source-neutral/);
});

test('PPR volume spike uses 1.5x current OANDA M5 tick volume against prior 20-bar baseline', () => {
  const candles = Array.from({ length: 21 }, (_, index) => candle({
    open: 1,
    high: 1.01,
    low: 0.99,
    close: 1,
    volume: index === 20 ? 150 : 100,
  }));
  const result = detectPprVolumeSpike(candles, {
    volumeLookback: 20,
    volumeSpikeMultiplier: 1.5,
  });
  assert.equal(result.detected, true);
  assert.equal(Number(result.ratio.toFixed(2)), 1.5);
});

test('PPR retains a valid raid without an age cutoff and measures retest distance', () => {
  const pools = { highs: [], lows: [{ price: 1.1, time: '2026-07-14T06:00:00Z' }] };
  const candles = [
    candle({ open: 1.105, high: 1.108, low: 1.102, close: 1.104, time: '2026-07-14T06:05:00Z' }),
    candle({ open: 1.104, high: 1.106, low: 1.095, close: 1.103, time: '2026-07-14T06:10:00Z' }),
    candle({ open: 1.103, high: 1.11, low: 1.101, close: 1.108, time: '2026-07-14T06:15:00Z' }),
    candle({ open: 1.108, high: 1.115, low: 1.104, close: 1.112, time: '2026-07-14T07:00:00Z' }),
    candle({ open: 1.102, high: 1.106, low: 1.1005, close: 1.103, time: '2026-07-14T09:00:00Z' }),
  ];
  const raid = detectPprLiquidityRaid({
    candles,
    pools,
    direction: 'long',
    pair: 'GBP_USD',
    currentEntry: 1.101,
  });
  assert.equal(raid?.subtype, 'sell_side_stop_hunt');
  assert.equal(raid?.retest, true);
  assert.equal(Number(raid.distancePips.toFixed(1)), 10);
});

test('PPR recognizes bullish FVG mitigation and order-block retest without static precedence', () => {
  const fvgCandles = [
    candle({ open: 1.09, high: 1.10, low: 1.08, close: 1.095 }),
    candle({ open: 1.10, high: 1.13, low: 1.099, close: 1.125 }),
    candle({ open: 1.12, high: 1.14, low: 1.11, close: 1.135 }),
    candle({ open: 1.13, high: 1.15, low: 1.12, close: 1.14 }),
    candle({ open: 1.14, high: 1.15, low: 1.13, close: 1.145 }),
    candle({ open: 1.145, high: 1.15, low: 1.135, close: 1.14 }),
    candle({ open: 1.14, high: 1.145, low: 1.105, close: 1.13 }),
    candle({ open: 1.115, high: 1.135, low: 1.105, close: 1.13 }),
  ];
  const fvg = detectPprFvgMitigation({ candles: fvgCandles, direction: 'long' });
  assert.equal(fvg?.type, 'fvg_mitigation');

  const blockCandles = [
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
  const block = detectPprOrderBlockRetest({
    candles: blockCandles,
    direction: 'long',
    atrValue: 0.008,
  });
  assert.equal(block?.type, 'order_block_retest');

  const composite = combinePprManipulations([
    { ...fvg, invalidation: 1.099, distancePips: 2 },
    { ...block, invalidation: 1.097, distancePips: 1 },
  ], 'long');
  assert.equal(composite.type, 'composite_misdirection');
  assert.deepEqual(composite.types.sort(), ['fvg_mitigation', 'order_block_retest']);
  assert.equal(composite.invalidation, 1.097);
});

test('PPR session and automated management stop at 10:00 ET weekdays', () => {
  assert.equal(pprSession(new Date('2026-07-14T06:00:00Z')).allowed, true);
  assert.equal(pprSession(new Date('2026-07-14T13:59:00Z')).allowed, true);
  assert.equal(pprSession(new Date('2026-07-14T14:00:00Z')).allowed, false);
  assert.equal(pprSession(new Date('2026-07-18T08:00:00Z')).allowed, false);
});
