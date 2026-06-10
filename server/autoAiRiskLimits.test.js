import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pin the caps to the documented defaults (1.5% / 4.5%) for these tests.
delete process.env.AUTO_AI_MAX_RISK_PER_TRADE_PERCENT;
delete process.env.AUTO_AI_MAX_TOTAL_OPEN_RISK_PERCENT;

const {
  autoAiRiskConfig,
  checkPerTradeRisk,
  capPerTradeRiskPercent,
  checkTotalOpenRisk,
  checkMargin,
  computeOpenRiskUSD,
  computeOpenRiskPercent,
  MARGIN_RESTRICTION_MESSAGE,
} = await import('./autoAiRiskLimits.js');

test('defaults are 1.5% per trade and 4.5% total open', () => {
  const cfg = autoAiRiskConfig();
  assert.equal(cfg.maxRiskPerTradePercent, 1.5);
  assert.equal(cfg.maxTotalOpenRiskPercent, 4.5);
});

test('risk per trade of exactly 1.5% is allowed', () => {
  const r = checkPerTradeRisk(1.5);
  assert.equal(r.allowed, true);
});

test('risk per trade above 1.5% is rejected', () => {
  const r = checkPerTradeRisk(1.6);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /exceeds Auto AI max 1\.5%/);
});

test('per-trade risk is clamped down to the cap', () => {
  assert.equal(capPerTradeRiskPercent(2.0), 1.5);
  assert.equal(capPerTradeRiskPercent(1.0), 1.0);
});

test('total open risk of exactly 4.5% is allowed', () => {
  const r = checkTotalOpenRisk(3.0, 1.5);
  assert.equal(r.allowed, true);
  assert.equal(r.projectedTotal, 4.5);
});

test('total open risk above 4.5% is rejected', () => {
  const r = checkTotalOpenRisk(3.1, 1.5);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /would exceed max 4\.5%/);
});

test('sufficient margin is allowed', () => {
  const r = checkMargin({ marginAvailable: 1000, estimatedMargin: 500 });
  assert.equal(r.allowed, true);
});

test('insufficient margin is blocked with the exact message', () => {
  const r = checkMargin({ marginAvailable: 100, estimatedMargin: 500 });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, MARGIN_RESTRICTION_MESSAGE);
  assert.equal(r.reason, 'Account margin restriction would be exceeded.');
});

test('unusable margin figures are blocked (never bypass broker restriction)', () => {
  assert.equal(checkMargin({ marginAvailable: NaN, estimatedMargin: 500 }).allowed, false);
  assert.equal(checkMargin({}).allowed, false);
});

test('open risk is derived from units × stop distance (exact for USD-quoted)', () => {
  // 50,000 EUR_USD long, entry 1.10, stop 1.08 → risk = 50000 × 0.02 = $1000.
  const trades = [{ instrument: 'EUR_USD', currentUnits: '50000', price: '1.10', stopLossOrder: { price: '1.08' } }];
  assert.equal(computeOpenRiskUSD(trades), 1000);
  assert.equal(computeOpenRiskPercent(trades, 10000), 10);
});

test('open trades with no stop contribute zero quantifiable risk', () => {
  const trades = [{ instrument: 'EUR_USD', currentUnits: '50000', price: '1.10' }];
  assert.equal(computeOpenRiskUSD(trades), 0);
});
