import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeVolatilityExpansion } from './volatilityExpansionEngine.js';

function bar(mid, range) {
  return { time: '', open: mid, high: mid + range / 2, low: mid - range / 2, close: mid, volume: 100 };
}

test('volatility: compressed flat ranges → compressed, high score', () => {
  const candles = [];
  for (let i = 0; i < 24; i++) candles.push(bar(1.1000, 0.0004));
  const r = analyzeVolatilityExpansion({ pair: 'EUR_USD', candles });
  assert.equal(r.compressionDetected, true);
  assert.equal(r.expansionDetected, false);
  assert.equal(r.volatilityState, 'compressed');
  assert.ok(r.volatilityScore >= 70, `favourable score (${r.volatilityScore})`);
});

test('volatility: squeeze then breakout → expanding, top score', () => {
  const candles = [];
  // 14 medium bars
  for (let i = 0; i < 14; i++) candles.push(bar(1.1000, 0.0009));
  // 3 tight "squeeze" bars right before the short window
  for (let i = 0; i < 3; i++) candles.push(bar(1.1000, 0.0002));
  // 5-bar short window: small → large directional breakout (but not a long run)
  const ramp = [0.0004, 0.0007, 0.0012, 0.0018, 0.0022];
  let mid = 1.1000;
  for (let i = 0; i < ramp.length; i++) { mid += 0.0004; candles.push(bar(mid, ramp[i])); }
  const r = analyzeVolatilityExpansion({ pair: 'EUR_USD', candles });
  assert.equal(r.expansionDetected, true);
  assert.equal(r.volatilityState, 'expanding');
  assert.equal(r.volatilityScore, 90);
});

test('volatility: long extended run → expanded, low score (avoid chasing)', () => {
  const candles = [];
  for (let i = 0; i < 18; i++) candles.push(bar(1.1000, 0.0004));
  // Strong sustained directional run with large bars
  let mid = 1.1000;
  for (let i = 0; i < 6; i++) { mid += 0.0030; candles.push(bar(mid, 0.0028)); }
  const r = analyzeVolatilityExpansion({ pair: 'EUR_USD', candles });
  assert.equal(r.expansionDetected, true);
  assert.equal(r.volatilityState, 'expanded');
  assert.ok(r.volatilityScore <= 30, `penalised as late (${r.volatilityScore})`);
});

test('volatility: ATR-ratio fallback for thin candles', () => {
  const compressed = analyzeVolatilityExpansion({ pair: 'EUR_USD', candles: [], atrPips: 6, atrHistorical: 10 });
  assert.equal(compressed.volatilityState, 'compressed');
  const expanded = analyzeVolatilityExpansion({ pair: 'EUR_USD', candles: [], atrPips: 16, atrHistorical: 10 });
  assert.equal(expanded.volatilityState, 'expanded');
});

test('volatility: no data → normal/neutral', () => {
  const r = analyzeVolatilityExpansion({ pair: 'EUR_USD' });
  assert.equal(r.volatilityState, 'normal');
  assert.equal(r.volatilityScore, 50);
});
