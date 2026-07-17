import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMarketStructure } from './marketStructureEngine.js';

let _t = Date.UTC(2026, 4, 25, 0, 0, 0);
function bar(high, low) {
  const mid = (high + low) / 2;
  const b = { time: new Date(_t).toISOString(), open: mid, high, low, close: mid, volume: 100 };
  _t += 15 * 60 * 1000;
  return b;
}
function flat(price) { return bar(price, price); }

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

const bullishStructure = () => makeStructure([
  { kind: 'low', price: 1.0900 },
  { kind: 'high', price: 1.0950 },
  { kind: 'low', price: 1.0920 },
  { kind: 'high', price: 1.0980 },
  { kind: 'low', price: 1.0940 },
  { kind: 'high', price: 1.1010 },
]);

const bearishStructure = () => makeStructure([
  { kind: 'high', price: 1.1010 },
  { kind: 'low', price: 1.0960 },
  { kind: 'high', price: 1.0990 },
  { kind: 'low', price: 1.0930 },
  { kind: 'high', price: 1.0970 },
  { kind: 'low', price: 1.0900 },
]);

test('market structure uses M15 rising HH HL sequence', () => {
  const r = analyzeMarketStructure({ pair: 'EUR_USD', m15Candles: bullishStructure() });
  assert.equal(r.structureTrend, 'bullish');
  assert.equal(r.timeframeUsed, 'M15');
  assert.equal(r.h1Used, false);
  assert.ok(r.structureStrength > 50, `strength ${r.structureStrength} > 50`);
});

test('market structure uses M15 falling LH LL sequence', () => {
  const r = analyzeMarketStructure({ pair: 'EUR_USD', m15Candles: bearishStructure() });
  assert.equal(r.structureTrend, 'bearish');
  assert.equal(r.timeframeUsed, 'M15');
  assert.equal(r.h1Used, false);
  assert.ok(r.structureStrength > 50);
});

test('H4 is fallback structure only when M15 is unavailable', () => {
  const r = analyzeMarketStructure({ pair: 'EUR_USD', h4Candles: bullishStructure(), m15Candles: [] });
  assert.equal(r.structureTrend, 'bullish');
  assert.equal(r.timeframeUsed, 'H4');
  assert.equal(r.h1Used, false);
});

test('H1 candles cannot influence market structure', () => {
  const m15 = bullishStructure();
  const h1 = bearishStructure();
  const withOpposingH1 = analyzeMarketStructure({
    pair: 'EUR_USD',
    m15Candles: m15,
    h1Candles: h1,
  });
  const withoutH1 = analyzeMarketStructure({ pair: 'EUR_USD', m15Candles: m15 });

  assert.equal(withOpposingH1.structureTrend, 'bullish');
  assert.equal(withOpposingH1.structureTrend, withoutH1.structureTrend);
  assert.equal(withOpposingH1.structureStrength, withoutH1.structureStrength);
  assert.equal(withOpposingH1.timeframeUsed, 'M15');
  assert.equal(withOpposingH1.h1Used, false);
});

test('market structure broadening sequence is ranging and capped', () => {
  const candles = makeStructure([
    { kind: 'low', price: 1.0950 },
    { kind: 'high', price: 1.0980 },
    { kind: 'low', price: 1.0930 },
    { kind: 'high', price: 1.1000 },
    { kind: 'low', price: 1.0910 },
    { kind: 'high', price: 1.1020 },
  ]);
  const r = analyzeMarketStructure({ pair: 'EUR_USD', m15Candles: candles });
  assert.equal(r.structureTrend, 'ranging');
  assert.ok(r.structureStrength <= 45, `ranging strength capped (${r.structureStrength})`);
});

test('market structure insufficient M15 H4 data degrades safely', () => {
  const r = analyzeMarketStructure({ pair: 'EUR_USD', m15Candles: [], h4Candles: [] });
  assert.equal(r.structureTrend, 'ranging');
  assert.equal(r.bosDetected, false);
  assert.equal(r.chochDetected, false);
  assert.equal(r.structureStrength, 0);
  assert.equal(r.timeframeUsed, null);
  assert.equal(r.h1Used, false);
});

test('market structure exposes BOS CHoCH booleans and break shape', () => {
  const r = analyzeMarketStructure({ pair: 'EUR_USD', m15Candles: bullishStructure() });
  assert.equal(typeof r.bosDetected, 'boolean');
  assert.equal(typeof r.chochDetected, 'boolean');
  if (r.lastStructureBreak) {
    assert.ok(['BOS', 'CHoCH'].includes(r.lastStructureBreak.kind));
    assert.ok(['bullish', 'bearish'].includes(r.lastStructureBreak.direction));
  }
});
