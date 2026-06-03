import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMarketStructure } from './marketStructureEngine.js';

let _t = Date.UTC(2026, 4, 25, 0, 0, 0);
function bar(high, low) {
  const mid = (high + low) / 2;
  const b = { time: new Date(_t).toISOString(), open: mid, high, low, close: mid, volume: 100 };
  _t += 60 * 60 * 1000;
  return b;
}
function flat(price) { return bar(price, price); }

// Build a candle series whose swing pivots hit the given levels in order.
// Each pivot bar spikes to its level; two flat filler bars sit at the midpoint
// between consecutive levels so the pivots are clean under a ±2 lookback.
function makeStructure(levels) {
  _t = Date.UTC(2026, 4, 25, 0, 0, 0);
  const bars = [flat(levels[0].price), flat(levels[0].price)];
  for (let i = 0; i < levels.length; i++) {
    const lv = levels[i];
    if (lv.kind === 'high') bars.push(bar(lv.price, lv.price - 0.001));
    else bars.push(bar(lv.price + 0.001, lv.price));
    const next = levels[i + 1] ? levels[i + 1].price : lv.price;
    const mid = (lv.price + next) / 2;
    bars.push(flat(mid), flat(mid));
  }
  bars.push(flat(levels[levels.length - 1].price), flat(levels[levels.length - 1].price));
  return bars;
}

test('market structure: rising HH/HL sequence → bullish', () => {
  const candles = makeStructure([
    { kind: 'low', price: 1.0900 },
    { kind: 'high', price: 1.0950 },
    { kind: 'low', price: 1.0920 },  // HL
    { kind: 'high', price: 1.0980 }, // HH
    { kind: 'low', price: 1.0940 },  // HL
    { kind: 'high', price: 1.1010 }, // HH
  ]);
  const r = analyzeMarketStructure({ pair: 'EUR_USD', h1Candles: candles });
  assert.equal(r.structureTrend, 'bullish');
  assert.ok(r.structureStrength > 50, `strength ${r.structureStrength} > 50`);
});

test('market structure: falling LH/LL sequence → bearish', () => {
  const candles = makeStructure([
    { kind: 'high', price: 1.1010 },
    { kind: 'low', price: 1.0960 },
    { kind: 'high', price: 1.0990 }, // LH
    { kind: 'low', price: 1.0930 },  // LL
    { kind: 'high', price: 1.0970 }, // LH
    { kind: 'low', price: 1.0900 },  // LL
  ]);
  const r = analyzeMarketStructure({ pair: 'EUR_USD', h1Candles: candles });
  assert.equal(r.structureTrend, 'bearish');
  assert.ok(r.structureStrength > 50);
});

test('market structure: broadening (HH+LL) → ranging, capped strength', () => {
  // Expanding range: higher highs AND lower lows, no HL/LH → no clean trend.
  const candles = makeStructure([
    { kind: 'low', price: 1.0950 },
    { kind: 'high', price: 1.0980 },
    { kind: 'low', price: 1.0930 },  // LL
    { kind: 'high', price: 1.1000 }, // HH
    { kind: 'low', price: 1.0910 },  // LL
    { kind: 'high', price: 1.1020 }, // HH
  ]);
  const r = analyzeMarketStructure({ pair: 'EUR_USD', h1Candles: candles });
  assert.equal(r.structureTrend, 'ranging');
  assert.ok(r.structureStrength <= 45, `ranging strength capped (${r.structureStrength})`);
});

test('market structure: insufficient data degrades safely', () => {
  const r = analyzeMarketStructure({ pair: 'EUR_USD', h1Candles: [] });
  assert.equal(r.structureTrend, 'ranging');
  assert.equal(r.bosDetected, false);
  assert.equal(r.chochDetected, false);
  assert.equal(r.structureStrength, 0);
});

test('market structure: exposes BOS/CHoCH booleans and lastStructureBreak shape', () => {
  const candles = makeStructure([
    { kind: 'low', price: 1.0900 },
    { kind: 'high', price: 1.0950 },
    { kind: 'low', price: 1.0920 },
    { kind: 'high', price: 1.0980 },
    { kind: 'low', price: 1.0940 },
    { kind: 'high', price: 1.1010 },
  ]);
  const r = analyzeMarketStructure({ pair: 'EUR_USD', h1Candles: candles });
  assert.equal(typeof r.bosDetected, 'boolean');
  assert.equal(typeof r.chochDetected, 'boolean');
  if (r.lastStructureBreak) {
    assert.ok(['BOS', 'CHoCH'].includes(r.lastStructureBreak.kind));
    assert.ok(['bullish', 'bearish'].includes(r.lastStructureBreak.direction));
  }
});
