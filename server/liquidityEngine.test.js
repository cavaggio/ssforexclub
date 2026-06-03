import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLiquidity } from './liquidityEngine.js';

// ─── Candle fixtures ─────────────────────────────────────────────────────────

function c(time, o, h, l, close) {
  return { time, open: o, high: h, low: l, close, volume: 100 };
}

// Two ISO weeks of daily candles (Mon–Fri). Week 1 high 1.1100, low 1.0900.
// Week 2 high 1.1050, low 1.0950; last completed day = 2026-05-29 H 1.1030 L 1.0970.
function dailyFixture() {
  return [
    c('2026-05-18T00:00:00Z', 1.10, 1.1100, 1.0950, 1.105), // wk1
    c('2026-05-19T00:00:00Z', 1.105, 1.1080, 1.0900, 1.102), // wk1 low
    c('2026-05-20T00:00:00Z', 1.102, 1.1090, 1.0980, 1.108),
    c('2026-05-21T00:00:00Z', 1.108, 1.1095, 1.1000, 1.104),
    c('2026-05-22T00:00:00Z', 1.104, 1.1060, 1.0990, 1.101),
    c('2026-05-25T00:00:00Z', 1.101, 1.1040, 1.0960, 1.103), // wk2
    c('2026-05-26T00:00:00Z', 1.103, 1.1050, 1.0950, 1.099),
    c('2026-05-27T00:00:00Z', 1.099, 1.1020, 1.0955, 1.100),
    c('2026-05-28T00:00:00Z', 1.100, 1.1010, 1.0958, 1.101),
    c('2026-05-29T00:00:00Z', 1.101, 1.1030, 1.0970, 1.102), // previous day
  ];
}

// H1 candles for the most recent day with an Asian session block (UTC 0–6)
// peaking at 1.1015 / troughing 1.0975, then a London block.
function h1Fixture() {
  const out = [];
  for (let h = 0; h < 7; h++) {
    out.push(c(`2026-05-29T0${h}:00:00Z`, 1.100, 1.1015, 1.0975, 1.101)); // Asian
  }
  for (let h = 7; h < 12; h++) {
    const hh = String(h).padStart(2, '0');
    out.push(c(`2026-05-29T${hh}:00:00Z`, 1.101, 1.1040, 1.1005, 1.103)); // London
  }
  return out;
}

// M15 candles forming two equal highs near 1.1020 and equal lows near 1.0980.
function m15EqualHighsFixture() {
  const out = [];
  let t = Date.UTC(2026, 4, 29, 0, 0, 0);
  const push = (h, l) => {
    out.push(c(new Date(t).toISOString(), (h + l) / 2, h, l, (h + l) / 2));
    t += 15 * 60 * 1000;
  };
  // Build a zig-zag with two highs at 1.1020 and two lows at 1.0980.
  const seq = [
    [1.1000, 1.0990], [1.1010, 1.0995],
    [1.1020, 1.1000], // pivot high #1
    [1.1005, 1.0985],
    [1.0995, 1.0980], // pivot low #1
    [1.1005, 1.0990],
    [1.1020, 1.1002], // pivot high #2 (equal)
    [1.1008, 1.0988],
    [1.0998, 1.0980], // pivot low #2 (equal)
    [1.1006, 1.0992], [1.1003, 1.0991], [1.1004, 1.0990],
  ];
  // Pad to satisfy the >=40 m15 requirement.
  for (let i = 0; i < 4; i++) for (const [h, l] of seq) push(h, l);
  return out;
}

test('liquidity engine: previous-day and previous-week pools', () => {
  const r = analyzeLiquidity({
    pair: 'EUR_USD',
    dailyCandles: dailyFixture(),
    h1Candles: h1Fixture(),
    m15Candles: [],
    currentPrice: 1.1010,
  });
  const labels = r.pools.map((p) => p.label);
  assert.ok(labels.includes('Previous Day High'), 'has PDH');
  assert.ok(labels.includes('Previous Day Low'), 'has PDL');
  const pdh = r.pools.find((p) => p.label === 'Previous Day High');
  const pdl = r.pools.find((p) => p.label === 'Previous Day Low');
  assert.equal(pdh.price, 1.103, 'PDH = last daily high');
  assert.equal(pdl.price, 1.097, 'PDL = last daily low');
  assert.ok(labels.includes('Previous Week High'), 'has PWH');
  const pwh = r.pools.find((p) => p.label === 'Previous Week High');
  assert.equal(pwh.price, 1.11, 'PWH = week-1 high');
});

test('liquidity engine: asian-session extremes', () => {
  const r = analyzeLiquidity({
    pair: 'EUR_USD',
    dailyCandles: dailyFixture(),
    h1Candles: h1Fixture(),
    currentPrice: 1.1010,
  });
  const ah = r.pools.find((p) => p.label === 'Asian Session High');
  const al = r.pools.find((p) => p.label === 'Asian Session Low');
  assert.ok(ah && al, 'asian session pools present');
  assert.equal(ah.price, 1.1015, 'asian high');
  assert.equal(al.price, 1.0975, 'asian low');
});

test('liquidity engine: nearest above/below + distance', () => {
  const r = analyzeLiquidity({
    pair: 'EUR_USD',
    dailyCandles: dailyFixture(),
    h1Candles: h1Fixture(),
    currentPrice: 1.1010,
  });
  assert.ok(r.nearestLiquidityAbove, 'has nearest above');
  assert.ok(r.nearestLiquidityBelow, 'has nearest below');
  assert.ok(r.nearestLiquidityAbove.price > 1.1010, 'above is above price');
  assert.ok(r.nearestLiquidityBelow.price < 1.1010, 'below is below price');
  assert.ok(typeof r.liquidityDistancePips === 'number' && r.liquidityDistancePips >= 0, 'distance computed');
  assert.equal(typeof r.liquiditySweepDetected, 'boolean');
});

test('liquidity engine: equal highs / lows clustering', () => {
  const r = analyzeLiquidity({
    pair: 'EUR_USD',
    dailyCandles: dailyFixture(),
    h1Candles: h1Fixture(),
    m15Candles: m15EqualHighsFixture(),
    currentPrice: 1.1005,
    atrPips: 12,
  });
  const labels = r.pools.map((p) => p.label);
  assert.ok(labels.includes('Equal Highs'), 'detected equal highs');
  assert.ok(labels.includes('Equal Lows'), 'detected equal lows');
});

test('liquidity engine: direction picks far-side target', () => {
  const r = analyzeLiquidity({
    pair: 'EUR_USD',
    dailyCandles: dailyFixture(),
    h1Candles: h1Fixture(),
    currentPrice: 1.1010,
    direction: 'long',
  });
  assert.ok(r.liquidityTarget, 'has target');
  assert.ok(r.liquidityTarget.price > 1.1010, 'long target sits above price (draw toward buy-side liquidity)');
});

test('liquidity engine: degrades gracefully with no data', () => {
  const r = analyzeLiquidity({ pair: 'EUR_USD' });
  assert.deepEqual(r.pools, []);
  assert.equal(r.nearestLiquidityAbove, null);
  assert.equal(r.liquiditySweepDetected, false);
  assert.equal(r.sweepDetected, false);
});

// ─── V3.5 additions ──────────────────────────────────────────────────────────

test('liquidity engine: London session pools (V3.5)', () => {
  const r = analyzeLiquidity({
    pair: 'EUR_USD',
    dailyCandles: dailyFixture(),
    h1Candles: h1Fixture(), // London block (UTC 7–11): high 1.1040, low 1.1005
    currentPrice: 1.1010,
  });
  const lh = r.pools.find((p) => p.label === 'London Session High');
  const ll = r.pools.find((p) => p.label === 'London Session Low');
  assert.ok(lh && ll, 'london session pools present');
  assert.equal(lh.price, 1.104, 'london high');
  assert.equal(ll.price, 1.1005, 'london low');
});

// A clear zig-zag of DISTINCT pivots (no equal clusters) so the most-recent
// swing high / low surface as their own single-touch pools.
function m15DistinctSwingsFixture() {
  const out = [];
  let t = Date.UTC(2026, 4, 29, 0, 0, 0);
  const push = (h, l) => {
    out.push(c(new Date(t).toISOString(), (h + l) / 2, h, l, (h + l) / 2));
    t += 15 * 60 * 1000;
  };
  // Gentle front candles (old) — none higher/lower than the recent swings.
  // Enough to push the total ≥ 40 so the M15 equal/swing block runs.
  for (let i = 0; i < 30; i++) push(1.1008, 1.0992);
  // Recent zig-zag with distinct, far-apart pivots.
  const seq = [
    [1.1030, 1.1010], // peak A
    [1.1005, 1.0985],
    [1.0970, 1.0950], // trough A
    [1.0990, 1.0975],
    [1.1040, 1.1015], // peak B
    [1.1010, 1.0990],
    [1.0960, 1.0940], // trough B
    [1.0995, 1.0975],
    [1.1055, 1.1030], // peak C — most recent high
    [1.1020, 1.1000],
    [1.0950, 1.0930], // trough C — most recent low
    [1.1000, 1.0985], // tail
    [1.1002, 1.0988], // tail
  ];
  for (const [h, l] of seq) push(h, l);
  return out;
}

test('liquidity engine: most-recent swing high / low pools (V3.5)', () => {
  const r = analyzeLiquidity({
    pair: 'EUR_USD',
    dailyCandles: dailyFixture(),
    h1Candles: h1Fixture(),
    m15Candles: m15DistinctSwingsFixture(),
    currentPrice: 1.1000,
  });
  const sh = r.pools.find((p) => p.source === 'SWING_H');
  const sl = r.pools.find((p) => p.source === 'SWING_L');
  assert.ok(sh, 'has a swing-high pool');
  assert.ok(sl, 'has a swing-low pool');
  assert.equal(sh.price, 1.1055, 'most recent swing high');
  assert.equal(sl.price, 1.093, 'most recent swing low');
});

// M15 whose 30→6 lookback low sits exactly on the previous-day low (1.0970),
// then the last bars wick below it and reclaim — a bullish sweep of the PDL.
function m15SweepsPdlFixture() {
  const out = [];
  let t = Date.UTC(2026, 4, 29, 0, 0, 0);
  const push = (o, h, l, cl) => { out.push(c(new Date(t).toISOString(), o, h, l, cl)); t += 15 * 60 * 1000; };
  for (let i = 0; i < 24; i++) {
    const lo = i === 5 ? 1.0970 : 1.0978 + (i % 3) * 0.0002; // lookback low = 1.0970
    push(1.0990, 1.1005, lo, 1.0992);
  }
  push(1.0990, 1.1000, 1.0980, 1.0990);
  push(1.0990, 1.1000, 1.0980, 1.0988);
  push(1.0988, 1.0995, 1.0978, 1.0985);
  push(1.0985, 1.0990, 1.0960, 1.0975); // wick below 1.0970
  push(1.0975, 1.0998, 1.0972, 1.0992); // reclaim — closes back above
  push(1.0992, 1.1000, 1.0985, 1.0995);
  return out;
}

test('liquidity engine: pool-aware sweep labels the swept level (V3.5)', () => {
  const r = analyzeLiquidity({
    pair: 'EUR_USD',
    dailyCandles: dailyFixture(), // PDL = 1.0970
    h1Candles: h1Fixture(),
    m15Candles: m15SweepsPdlFixture(),
    currentPrice: 1.0992,
  });
  assert.equal(r.sweepDetected, true, 'a sweep was detected');
  assert.equal(r.sweepDirection, 'bullish');
  assert.equal(r.liquiditySweep.sweptSource, 'PDL', 'named the swept pool');
  assert.equal(r.sweptLiquidity, 'Previous Day Low');
  assert.ok(r.sweepStrength > 0.5, 'major sweep scored strong');
});
