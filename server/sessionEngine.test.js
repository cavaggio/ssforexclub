import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSession, sessionForHour } from './sessionEngine.js';

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
