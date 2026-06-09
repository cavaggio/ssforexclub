import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentKillzone, activeMacro, inSilverBulletWindow } from './ictTime.js';
import { analyzeICTPair } from './ictEngine.js';

// June 2026 is EDT (UTC-4): UTC hour − 4 = ET hour.

test('killzones: ET windows are detected DST-aware', () => {
  assert.equal(currentKillzone('2026-06-04T07:00:00Z').currentKillzone, 'London');        // 03:00 ET
  assert.equal(currentKillzone('2026-06-04T12:00:00Z').currentKillzone, 'New York AM');    // 08:00 ET
  assert.equal(currentKillzone('2026-06-04T14:30:00Z').currentKillzone, 'New York AM (Silver Bullet)'); // 10:30 ET
  assert.equal(currentKillzone('2026-06-04T01:00:00Z').currentKillzone, 'Asian');          // 21:00 ET prev day
  assert.equal(currentKillzone('2026-06-04T15:30:00Z').inKillzone, false);                 // 11:30 ET — between Silver Bullet and NY PM
});

test('silver bullet + macro windows', () => {
  assert.equal(inSilverBulletWindow('2026-06-04T14:30:00Z'), true);   // 10:30 ET
  assert.equal(inSilverBulletWindow('2026-06-04T12:00:00Z'), false);  // 08:00 ET
  assert.equal(activeMacro('2026-06-04T13:55:00Z').activeMacro, 'New York AM macro'); // 09:55 ET
  assert.equal(activeMacro('2026-06-04T17:25:00Z').activeMacro, 'New York PM macro'); // 13:25 ET
  assert.equal(activeMacro('2026-06-04T12:00:00Z').activeMacro, null);                // 08:00 ET
});

// Synthetic candle generator — a gentle one-directional drift (no sweep, no MSS).
function gen(n, base, step, vol, startMs) {
  const out = []; let t = startMs; let p = base;
  for (let i = 0; i < n; i++) {
    const o = p; const close = o + step + (i % 3 - 1) * vol;
    out.push({ time: new Date(t).toISOString(), open: o, high: Math.max(o, close) + vol, low: Math.min(o, close) - vol, close, volume: 100 });
    p = close; t += 15 * 60 * 1000;
  }
  return out;
}

function buildCandles(base = 1.10) {
  const start = Date.UTC(2026, 5, 1, 0, 0, 0);
  return {
    monthly: gen(6, base - 0.02, 0.005, 0.002, start),
    weekly: gen(12, base - 0.01, 0.002, 0.001, start),
    daily: gen(60, base - 0.01, 0.0006, 0.0008, start),
    h4: gen(60, base, 0.0004, 0.0006, start),
    h1: gen(120, base, 0.0002, 0.0004, start),
    m15: gen(160, base, 0.00012, 0.0003, start),
    m5: gen(120, base, 0.0001, 0.0002, start),
  };
}

test('engine: returns the exact response object shape', () => {
  const r = analyzeICTPair({ pair: 'EUR_USD', candles: buildCandles(), peers: {}, now: new Date('2026-06-04T14:30:00Z') });
  for (const k of ['pair', 'timestamp', 'ictBias', 'ictNarrative', 'setupType', 'signal', 'entry', 'stopLoss', 'target1', 'target2', 'rr', 'confidence', 'conceptsDetected', 'rejectionReasons']) {
    assert.ok(k in r, `missing key ${k}`);
  }
  assert.ok(Array.isArray(r.conceptsDetected));
  assert.ok(Array.isArray(r.rejectionReasons));
});

test('engine is ICT-first: a plain drift with no sweep/MSS produces NO signal', () => {
  const r = analyzeICTPair({ pair: 'EUR_USD', candles: buildCandles(), peers: {}, now: new Date('2026-06-04T14:30:00Z') });
  assert.equal(r.signal, 'none');
  assert.ok(r.rejectionReasons.length > 0, 'has rejection reasons');
  assert.ok(
    r.rejectionReasons.some((x) => /not swept|MSS|displacement|FVG|OB/i.test(x)),
    'rejects for a missing ICT condition, not an indicator',
  );
});

test('engine: silver-bullet window flag is reflected in concepts', () => {
  const r = analyzeICTPair({ pair: 'EUR_USD', candles: buildCandles(), peers: {}, now: new Date('2026-06-04T14:30:00Z') });
  assert.equal(r.concepts.silverBullet.activeWindow, true);
  // Outside the window it is inactive.
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
  c.daily = gen(60, 1.09, 0.0006, 0.0008, start);   // uptrend
  c.h4 = gen(60, 1.13, -0.0004, 0.0006, start);      // downtrend
  return c;
}

test('timeframe: Daily and 4H must agree directionally', () => {
  const r = analyzeICTPair({ pair: 'EUR_USD', candles: mismatchedCandles(), peers: {}, now: new Date('2026-06-04T14:30:00Z') });
  assert.equal(r.signal, 'none');
  assert.ok(r.rejectionReasons.some((x) => /Daily and 4H directional bias are not aligned/.test(x)));
});

test('timeframe: 5M cannot override a Daily/4H mismatch', () => {
  const c = mismatchedCandles();
  c.m5 = gen(120, 1.10, 0.0008, 0.0006, Date.UTC(2026, 5, 1, 0, 0, 0)); // lively 5M activity
  const r = analyzeICTPair({ pair: 'EUR_USD', candles: c, peers: {}, now: new Date('2026-06-04T14:30:00Z') });
  assert.equal(r.signal, 'none', 'no qualification despite 5M activity');
  assert.ok(r.rejectionReasons.some((x) => /not aligned/.test(x)));
});

test('candle strength is never a hard rejection in ICT', () => {
  const r = analyzeICTPair({ pair: 'EUR_USD', candles: buildCandles(), peers: {}, now: new Date('2026-06-04T14:30:00Z') });
  assert.ok(!r.rejectionReasons.some((x) => /candle strength|profile floor/i.test(x)), 'no candle-strength reject');
  assert.ok(r.concepts && r.concepts.candle && r.concepts.candle.informationalOnly === true, 'candle context is informational');
});
