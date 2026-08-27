import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentKillzone, activeMacro, inSilverBulletWindow } from './ictTime.js';
import { analyzeICTPair, computeIctConfidence } from './ictEngine.js';

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
  assert.deepEqual(Object.keys(r.timeframeBias).sort(), [
    'd1', 'd1H4Aligned', 'direction', 'h1', 'h1ActiveMomentum', 'h1AnalysisOnly', 'h1MomentumExecutionGate', 'h1MomentumPhase', 'h4',
  ]);
  assert.equal(r.timeframeBias.h1AnalysisOnly, true);
  assert.equal(r.timeframeBias.h1MomentumExecutionGate, true);
  assert.equal(r.concepts.htf.h1Bias, r.timeframeBias.h1);
});

test('timeframe display: D1/H4 own direction while H1 active momentum is an execution gate', () => {
  const c = buildCandles();
  const start = Date.UTC(2026, 5, 1, 0, 0, 0);
  c.h1 = gen(120, 1.13, -0.0002, 0.0004, start); // bearish H1 against bullish D1/H4
  const r = analyzeICTPair({ pair: 'EUR_USD', candles: c, peers: {}, now: new Date('2026-06-04T14:30:00Z') });

  assert.equal(r.timeframeBias.d1, 'bullish');
  assert.equal(r.timeframeBias.h4, 'bullish');
  assert.equal(r.timeframeBias.h1, 'bearish');
  assert.equal(r.timeframeBias.direction, 'buy');
  assert.equal(r.timeframeBias.h1AnalysisOnly, true);
  assert.equal(r.timeframeBias.h1MomentumExecutionGate, true);
  assert.equal(r.h1Momentum.activeDirection, 'bearish');
  assert.equal(r.h1Momentum.aligned, false);
});

test('scalp entry: H1 opens the window but the setup price comes from M5', () => {
  const c = buildCandles();
  const h1Price = 1.2500;
  const m5Price = 1.13579;
  c.h1[c.h1.length - 1] = {
    ...c.h1[c.h1.length - 1],
    close: h1Price,
    high: h1Price + 0.0004,
    complete: false,
  };
  c.m5[c.m5.length - 1] = {
    ...c.m5[c.m5.length - 1],
    close: m5Price,
    high: m5Price + 0.0002,
    low: m5Price - 0.0002,
  };

  const r = analyzeICTPair({ pair: 'EUR_USD', candles: c, peers: {}, now: new Date('2026-06-04T14:30:00Z') });

  assert.equal(r.entryTimeframe, '5M');
  assert.equal(r.entryCandle.priceSource, 'latest_5m_close');
  assert.equal(r.entry, m5Price);
  assert.notEqual(r.entry, h1Price);
});

test('scalp entry: M15 cannot substitute for missing M5 candles', () => {
  const c = buildCandles();
  c.m5 = c.m5.slice(-10);
  const r = analyzeICTPair({ pair: 'EUR_USD', candles: c, peers: {}, now: new Date('2026-06-04T14:30:00Z') });

  assert.equal(r.signal, 'none');
  assert.match(r.rejectionReasons[0], /Insufficient 5M candle data/i);
});

test('scalp entry: a ready H1 transition still requires a complete strategy-specific M5 trigger', () => {
  const c = buildCandles();
  c.h1[c.h1.length - 2] = {
    time: '2026-06-04T14:00:00Z', open: 1.1020, high: 1.1022,
    low: 1.0998, close: 1.1000, volume: 100, complete: true,
  };
  c.h1[c.h1.length - 1] = {
    time: '2026-06-04T15:00:00Z', open: 1.1000, high: 1.1004,
    low: 1.0999, close: 1.1002, volume: 100, complete: false,
  };
  c.m5 = Array.from({ length: 120 }, (_, index) => ({
    time: new Date(Date.UTC(2026, 5, 4, 5, index * 5, 0)).toISOString(),
    open: 1.1000, high: 1.1001, low: 1.0999, close: 1.1000, volume: 100,
  }));

  const r = analyzeICTPair({ pair: 'EUR_USD', candles: c, peers: {}, now: new Date('2026-06-04T15:08:00Z') });

  assert.equal(r.h1Transition.ready, true);
  assert.equal(r.entryTimeframe, '5M');
  assert.equal(r.entryCandle.triggerReady, false);
  assert.equal(r.signal, 'none');
  assert.ok(r.rejectionReasons.some((reason) => /no ICT strategy is authorized/i.test(reason)));
  assert.ok(!r.rejectionReasons.some((reason) => /central market-maker execution is not authorized/i.test(reason)));
});

test('refactor: only hard gates reject — soft concepts never appear as hard rejections', () => {
  const r = analyzeICTPair({ pair: 'EUR_USD', candles: buildCandles(), peers: {}, now: new Date('2026-06-04T14:30:00Z') });
  for (const rr of r.rejectionReasons) {
    // FVG/OB/displacement/MSS/CHoCH are confluence now — never a hard "No X" rejection.
    assert.ok(!/No .*(displacement|FVG|OB|MSS|CHoCH|order block)/i.test(rr), `soft concept leaked into rejection: "${rr}"`);
    // Every rejection is clearly labeled: hard gate or the authoritative target-hit floor.
    assert.ok(
      /^Hard gate:/.test(rr) ||
      /^Confluence below display threshold/.test(rr) ||
      /^Target-hit confidence below execution threshold/.test(rr),
      `unlabeled rejection: "${rr}"`,
    );
  }
});

test('refactor: confidence scoring — hard-gate base clears 70, full confluence clears 80', () => {
  // Aligned + active killzone + sweep + 5M trigger alone clears the display threshold.
  const base = computeIctConfidence({ htfAligned: true, killzoneQuality: 95, sweepAligned: true, drawPresent: true, entryTrigger: true });
  assert.ok(base >= 70, `base confidence ${base} should be >= 70`);
  // Full confluence clears the auto-execute threshold.
  const full = computeIctConfidence({ htfAligned: true, killzoneQuality: 90, sweepAligned: true, drawPresent: true, entryTrigger: true, displacementAligned: true, mssOrChoch: true, fvgInDir: true, obInDir: true, inOteZone: true, smt: true, inducementSwept: true, labels: 2, rr: 3 });
  assert.ok(full >= 80, `full confidence ${full} should be >= 80`);
  // Daily/4H not aligned → zero (alignment is the hard-gated base).
  assert.equal(computeIctConfidence({ htfAligned: false, killzoneQuality: 95, sweepAligned: true, entryTrigger: true }), 0);
  // Draw-only (no sweep, no extra confluence) sits below the threshold.
  assert.ok(computeIctConfidence({ htfAligned: true, killzoneQuality: 90, drawPresent: true, entryTrigger: true }) < 70);
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
  assert.ok(r.rejectionReasons.some((x) => /Daily and 4H are not aligned for continuation and no current-day studied reversal direction is available/.test(x)));
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
