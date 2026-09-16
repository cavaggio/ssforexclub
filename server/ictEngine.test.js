import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeICTPair } from './ictEngine.js';

function gen(n, start, step, wick = 0.0006, t0 = Date.UTC(2026, 5, 1, 0, 0, 0), tfMs = 300000) {
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = p + step;
    out.push({ time: new Date(t0 + i * tfMs).toISOString(), open: o, high: Math.max(o, c) + wick, low: Math.min(o, c) - wick, close: c, volume: 1000 + i });
    p = c;
  }
  return out;
}

function buildCandles() {
  const t0 = Date.UTC(2026, 5, 1, 0, 0, 0);
  return {
    daily: gen(60, 1.08, 0.0005, 0.0008, t0, 86400000),
    h4: gen(60, 1.09, 0.00035, 0.0007, t0, 14400000),
    h1: gen(100, 1.10, 0.0002, 0.0005, t0, 3600000),
    m15: gen(160, 1.11, 0.00008, 0.00035, t0, 900000),
    m5: gen(240, 1.115, 0.00003, 0.00025, t0, 300000),
  };
}

// Keep existing concept coverage compact but deterministic.
test('engine: returns a structured ICT analysis', () => {
  const r = analyzeICTPair({ pair: 'EUR_USD', candles: buildCandles(), peers: {}, now: new Date('2026-06-04T14:30:00Z') });
  assert.equal(r.pair, 'EUR_USD');
  assert.ok(r.concepts);
  assert.ok(Array.isArray(r.rejectionReasons));
  assert.ok(r.timeframeBias);
});

test('engine: silver-bullet window flag is reflected in concepts', () => {
  const r = analyzeICTPair({ pair: 'EUR_USD', candles: buildCandles(), peers: {}, now: new Date('2026-06-04T14:30:00Z') });
  assert.equal(typeof r.concepts.silverBullet.activeWindow, 'boolean');
  const r2 = analyzeICTPair({ pair: 'EUR_USD', candles: buildCandles(), peers: {}, now: new Date('2026-06-04T12:00:00Z') });
  assert.equal(r2.concepts.silverBullet.activeWindow, false);
});

test('engine: degrades safely on insufficient data', () => {
  const r = analyzeICTPair({ pair: 'EUR_USD', candles: { m15: [], m5: [] }, peers: {}, now: new Date('2026-06-04T14:30:00Z') });
  assert.equal(r.signal, 'none');
  assert.equal(r.confidence, 0);
  assert.ok(r.rejectionReasons.length > 0);
});

// Daily up, 4H down → directional disagreement.
function mismatchedCandles() {
  const start = Date.UTC(2026, 5, 1, 0, 0, 0);
  const c = buildCandles();
  c.daily = gen(60, 1.09, 0.0006, 0.0008, start, 86400000);   // uptrend
  c.h4 = gen(60, 1.13, -0.0004, 0.0006, start, 14400000);    // downtrend
  return c;
}

test('timeframe: Daily and 4H mismatch cannot qualify without the full reversal sequence', () => {
  const r = analyzeICTPair({ pair: 'EUR_USD', candles: mismatchedCandles(), peers: {}, now: new Date('2026-06-04T14:30:00Z') });
  assert.equal(r.timeframeBias?.d1H4Aligned, false);
  assert.equal(r.signal, 'none');
  assert.ok(r.entryAuthorization?.ready !== true || r.correctiveGate?.passed !== true);
});

test('timeframe: 5M activity cannot override an unauthorized Daily/4H mismatch', () => {
  const c = mismatchedCandles();
  c.m5 = gen(120, 1.10, 0.0008, 0.0006, Date.UTC(2026, 5, 1, 0, 0, 0), 300000);
  const r = analyzeICTPair({ pair: 'EUR_USD', candles: c, peers: {}, now: new Date('2026-06-04T14:30:00Z') });
  assert.equal(r.timeframeBias?.d1H4Aligned, false);
  assert.equal(r.signal, 'none', 'no qualification despite 5M activity');
  assert.ok(r.entryAuthorization?.ready !== true || r.correctiveGate?.passed !== true);
});

test('candle strength is never a hard rejection in ICT', () => {
  const r = analyzeICTPair({ pair: 'EUR_USD', candles: buildCandles(), peers: {}, now: new Date('2026-06-04T14:30:00Z') });
  assert.ok(!r.rejectionReasons.some((x) => /candle strength|profile floor/i.test(x)), 'no candle-strength reject');
  assert.ok(r.concepts && r.concepts.candle && r.concepts.candle.informationalOnly === true, 'candle context is informational');
});
