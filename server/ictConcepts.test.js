import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectFVGs, detectDisplacement, detectOrderBlock, detectMSS,
  detectTurtleSoup, computePremiumDiscount, computeOTE, buildLiquidityMap,
} from './ictConcepts.js';

let _t = Date.UTC(2026, 5, 4, 0, 0, 0);
function c(o, h, l, close) {
  const cd = { time: new Date(_t).toISOString(), open: o, high: h, low: l, close, volume: 100 };
  _t += 15 * 60 * 1000;
  return cd;
}
// n tiny candles around `base` (body ~2 pips), used as quiet context.
function flat(n, base) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(c(base, base + 0.0003, base - 0.0003, base + 0.0001));
  return out;
}

test('FVG: detects a fresh bullish 3-candle gap (status open)', () => {
  const candles = [
    ...flat(4, 1.1000),
    c(1.1002, 1.1010, 1.1000, 1.1008), // c1
    c(1.1008, 1.1047, 1.1007, 1.1045), // c2 displacement (big body)
    c(1.1040, 1.1050, 1.1032, 1.1045), // c3 → low 1.1032 > c1.high 1.1010
    c(1.1045, 1.1050, 1.1040, 1.1043), // trailing (does not fill gap)
  ];
  const fvgs = detectFVGs({ candles, pair: 'EUR_USD' });
  assert.ok(fvgs.length >= 1, 'found a FVG');
  const f = fvgs[0];
  assert.equal(f.type, 'bullish');
  assert.equal(f.status, 'open');
  assert.ok(f.low < f.high && f.midpoint > f.low && f.midpoint < f.high);
});

test('FVG: a later candle that trades through the gap marks it filled', () => {
  const candles = [
    ...flat(4, 1.1000),
    c(1.1002, 1.1010, 1.1000, 1.1008),
    c(1.1008, 1.1047, 1.1007, 1.1045),
    c(1.1040, 1.1050, 1.1032, 1.1045), // bullish gap 1.1010–1.1032
    c(1.1030, 1.1031, 1.1005, 1.1009), // trades back below gapLow → filled
  ];
  const fvgs = detectFVGs({ candles, pair: 'EUR_USD' });
  const f = fvgs.find((x) => x.type === 'bullish');
  assert.ok(f, 'gap present');
  assert.equal(f.status, 'filled');
});

test('Displacement: large directional body breaking structure scores bullish', () => {
  const candles = [...flat(24, 1.1000), c(1.1001, 1.1041, 1.1000, 1.1039)];
  const d = detectDisplacement({ candles, pair: 'EUR_USD' });
  assert.equal(d.direction, 'bullish');
  assert.ok(d.displacementScore > 0);
  assert.equal(d.candleIndex, candles.length - 1);
});

test('Order block: last down candle before a bullish displacement', () => {
  const candles = [
    ...flat(23, 1.1010),
    c(1.1010, 1.1011, 1.1003, 1.1004), // bearish OB candle
    c(1.1004, 1.1045, 1.1003, 1.1043), // bullish displacement
  ];
  const ob = detectOrderBlock({ candles, pair: 'EUR_USD' });
  assert.equal(ob.type, 'bullish');
  assert.equal(ob.mitigated, false);
  assert.ok(ob.strengthScore > 0 && ob.low < ob.high);
});

test('MSS: sweep of sell-side then break of swing high = bullish MSS', () => {
  const candles = [
    ...flat(16, 1.1022),
    c(1.1022, 1.1025, 1.1015, 1.1020),
    c(1.1020, 1.1028, 1.1018, 1.1024),
    c(1.1024, 1.1050, 1.1030, 1.1045), // swing HIGH 1.1050
    c(1.1045, 1.1035, 1.1020, 1.1030),
    c(1.1030, 1.1030, 1.1015, 1.1022),
    c(1.1022, 1.1025, 1.1000, 1.1010), // swing LOW 1.1000
    c(1.1010, 1.1028, 1.1012, 1.1024),
    c(1.1024, 1.1030, 1.1018, 1.1026),
    c(1.1026, 1.1032, 1.1020, 1.1028),
    c(1.1028, 1.1030, 1.0995, 1.1005), // sweep below 1.1000
    c(1.1005, 1.1060, 1.1010, 1.1055), // break above swing high 1.1050
  ];
  const mss = detectMSS({ candles, pair: 'EUR_USD' });
  assert.equal(mss.direction, 'bullish');
  assert.equal(mss.confirmed, true);
  assert.ok(mss.sweptLevel <= 1.1000 + 1e-9);
});

test('Turtle Soup: sweep equal lows, reclaim, bullish displacement', () => {
  const candles = [
    ...flat(23, 1.1010),
    c(1.1010, 1.1012, 1.0996, 1.1002), // dips below equal low 1.1000
    c(1.1002, 1.1035, 1.1001, 1.1032), // reclaim + displacement up
  ];
  const liquidityMap = { sellSideLiquidity: [{ source: 'EQL', price: 1.1000 }], buySideLiquidity: [] };
  const ts = detectTurtleSoup({ candles, pair: 'EUR_USD', liquidityMap });
  assert.equal(ts.turtleSoupDetected, true);
  assert.equal(ts.direction, 'bullish');
  assert.equal(ts.reclaimConfirmed, true);
});

test('Premium/Discount: zones relative to equilibrium', () => {
  const fib = { swingHigh: 1.1100, swingLow: 1.1000 }; // eq 1.1050
  assert.equal(computePremiumDiscount({ pair: 'EUR_USD', currentPrice: 1.1020, fib }).currentZone, 'discount');
  assert.equal(computePremiumDiscount({ pair: 'EUR_USD', currentPrice: 1.1080, fib }).currentZone, 'premium');
  assert.equal(computePremiumDiscount({ pair: 'EUR_USD', currentPrice: 1.1050, fib }).currentZone, 'equilibrium');
  assert.equal(computePremiumDiscount({ pair: 'EUR_USD', currentPrice: 1.105, fib: null }).currentZone, 'unknown');
});

test('OTE: 62–79% retracement zone for a long', () => {
  const fib = { swingHigh: 1.1100, swingLow: 1.1000 };
  const ote = computeOTE({ pair: 'EUR_USD', currentPrice: 1.1030, fib, direction: 'long' });
  // long zone ≈ 1.1021 (79%) … 1.1038 (62%)
  assert.ok(ote.oteLow < ote.oteHigh);
  assert.equal(ote.priceInOTE, true);
  assert.ok(ote.oteQuality > 0);
  const outside = computeOTE({ pair: 'EUR_USD', currentPrice: 1.1095, fib, direction: 'long' });
  assert.equal(outside.priceInOTE, false);
});

test('Liquidity map: classifies buy/sell-side, adds previous-month + round numbers', () => {
  const analyzed = {
    pools: [
      { label: 'Previous Day High', kind: 'high', price: 1.1060, source: 'PDH', distancePips: 60 },
      { label: 'Previous Day Low', kind: 'low', price: 1.0950, source: 'PDL', distancePips: 50 },
    ],
    liquiditySweep: { direction: 'bullish', sweptLiquidity: 'Previous Day Low', sweptSource: 'PDL' },
  };
  const monthlyCandles = [
    { open: 1.08, high: 1.12, low: 1.07, close: 1.10 },
    { open: 1.10, high: 1.1180, low: 1.0920, close: 1.1000 }, // previous month
  ];
  const map = buildLiquidityMap({ pair: 'EUR_USD', currentPrice: 1.1000, analyzed, monthlyCandles });
  assert.ok(map.buySideLiquidity.some((p) => p.source === 'PMH'), 'has previous-month high');
  assert.ok(map.sellSideLiquidity.some((p) => p.source === 'PML'), 'has previous-month low');
  assert.ok([...map.buySideLiquidity, ...map.sellSideLiquidity].some((p) => p.source === 'ROUND'), 'has round numbers');
  assert.ok(map.buySideLiquidity.every((p) => p.price > 1.1000));
  assert.ok(map.sellSideLiquidity.every((p) => p.price < 1.1000));
  assert.equal(map.sweptLiquidity.source, 'PDL');
});
