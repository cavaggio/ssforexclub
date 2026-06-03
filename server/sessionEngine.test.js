import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSession, sessionForHour, buildSessionNarrative } from './sessionEngine.js';

test('session: classifies UTC hours correctly', () => {
  assert.equal(sessionForHour(13), 'London/NewYork Overlap');
  assert.equal(sessionForHour(8), 'Tokyo/London Overlap');
  assert.equal(sessionForHour(10), 'London');
  assert.equal(sessionForHour(18), 'NewYork');
  assert.equal(sessionForHour(4), 'Tokyo');
  assert.equal(sessionForHour(22), 'Sydney');
});

test('session: NY-open overlap is highest quality', () => {
  const r = analyzeSession({ now: new Date('2026-06-01T13:00:00Z') });
  assert.equal(r.activeSession, 'London/NewYork Overlap');
  assert.equal(r.sessionQualityScore, 95);
});

test('session: dead Asian hours score low', () => {
  const r = analyzeSession({ now: new Date('2026-06-01T22:00:00Z') });
  assert.equal(r.activeSession, 'Sydney');
  assert.ok(r.sessionQualityScore <= 40, `low quality (${r.sessionQualityScore})`);
});

test('session: measured ATR ratio drives volatility label', () => {
  const high = analyzeSession({ now: new Date('2026-06-01T13:00:00Z'), atrPips: 20, atrHistorical: 10 });
  assert.equal(high.sessionVolatility, 'high');
  const low = analyzeSession({ now: new Date('2026-06-01T13:00:00Z'), atrPips: 5, atrHistorical: 10 });
  assert.equal(low.sessionVolatility, 'low');
});

test('session: bias derived from recent intraday flow', () => {
  const up = [];
  for (let i = 0; i < 6; i++) up.push({ time: '', open: 1.10 + i * 0.001, high: 1.101 + i * 0.001, low: 1.099 + i * 0.001, close: 1.1005 + i * 0.001 });
  const r = analyzeSession({ now: new Date('2026-06-01T13:00:00Z'), h1Candles: up });
  assert.equal(r.sessionBias, 'bullish');
});

// ─── V3.5 session narrative ──────────────────────────────────────────────────

test('session narrative: London sweep of Asian Low (+ CHoCH reversal)', () => {
  const r = buildSessionNarrative({
    session: { activeSession: 'London', sessionBias: 'neutral', sessionQualityScore: 80, sessionVolatility: 'normal' },
    liquidity: { liquiditySweep: { direction: 'bullish', sweptSource: 'ASIA_L', sweptLiquidity: 'Asian Session Low' } },
    structure: { chochDetected: true, choch: { direction: 'bullish' } },
  });
  assert.match(r.sessionNarrative, /London swept Asian Low/);
  assert.match(r.sessionNarrative, /reversal/);
  assert.equal(r.sessionBias, 'bullish', 'sweep direction sets the bias');
  assert.ok(r.sessionConfidence > 0.8, 'sweep + aligned CHoCH lifts confidence');
});

test('session narrative: New York continuation', () => {
  const r = buildSessionNarrative({
    session: { activeSession: 'NewYork', sessionBias: 'bullish', sessionQualityScore: 76 },
    liquidity: { liquiditySweep: null },
    structure: { bosDetected: true, bos: { direction: 'bullish' }, structureTrend: 'bullish' },
  });
  assert.equal(r.sessionNarrative, 'New York continuation');
});

test('session narrative: falls back to session + bias when nothing fires', () => {
  const r = buildSessionNarrative({
    session: { activeSession: 'Tokyo', sessionBias: 'neutral', sessionQualityScore: 50, sessionVolatility: 'normal' },
    liquidity: null,
    structure: { structureTrend: 'ranging', bosDetected: false, chochDetected: false },
  });
  assert.match(r.sessionNarrative, /Tokyo/);
});
