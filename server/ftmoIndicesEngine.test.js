import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFtmoIndexSetup, calculateFtmoIndexVolume } from './ftmoIndicesEngine.js';
import { evaluateIndicesPortfolioRisk } from './ftmoIndicesExecution.js';

function candlesForBullishSetup() {
  const candles = [];
  for (let i = 0; i < 18; i += 1) {
    const base = 6000 + i;
    candles.push({ open: base, high: base + 3, low: base - 3, close: base + 1 });
  }
  candles.push({ open: 6018, high: 6020, low: 5990, close: 6019 });
  candles.push({ open: 6019, high: 6050, low: 6018, close: 6048 });
  return candles;
}

test('FTMO indices engine stays fail-closed outside execution window', () => {
  const result = analyzeFtmoIndexSetup({
    symbol: 'US500.cash', dailyBias: 'bullish', fourHourBias: 'bullish', oneHourBias: 'bullish',
    now: '2026-07-30T12:00:00.000Z', candles5m: candlesForBullishSetup(), atr: 10,
  });
  assert.equal(result.qualified, false);
  assert.ok(result.reasons.some((reason) => reason.startsWith('SESSION_')));
});

test('volume sizing uses broker tick value and step', () => {
  const volume = calculateFtmoIndexVolume({
    equity: 100000, riskPercent: 0.5, entry: 6000, stopLoss: 5990,
    tickSize: 0.1, tickValue: 0.1, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01,
  });
  assert.equal(volume, 50);
});

test('correlated index portfolio blocks a third position', () => {
  const result = evaluateIndicesPortfolioRisk({
    account: { balance: 100000, equity: 100000 },
    positions: [
      { symbol: 'US500.cash', riskPercent: 0.2 },
      { symbol: 'US100.cash', riskPercent: 0.2 },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'FTMO_INDICES_CORRELATED_POSITION_CAP');
});
