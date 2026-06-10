import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pin the total-open cap to the documented default (4.5%).
delete process.env.AUTO_AI_MAX_TOTAL_OPEN_RISK_PERCENT;

const {
  autoAiRiskConfig,
  checkTotalOpenRisk,
  checkMargin,
  computeOpenRiskUSD,
  computeOpenRiskPercent,
  MARGIN_RESTRICTION_MESSAGE,
} = await import('./autoAiRiskLimits.js');

test('default total open risk cap is 4.5%', () => {
  assert.equal(autoAiRiskConfig().maxTotalOpenRiskPercent, 4.5);
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

test('checkMargin is re-exported from the central risk manager', () => {
  assert.equal(checkMargin({ marginAvailable: 1000, estimatedMargin: 500 }).allowed, true);
  const blocked = checkMargin({ marginAvailable: 100, estimatedMargin: 500 });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, MARGIN_RESTRICTION_MESSAGE);
});

test('open risk is derived from units × stop distance (exact for USD-quoted)', () => {
  const trades = [{ instrument: 'EUR_USD', currentUnits: '50000', price: '1.10', stopLossOrder: { price: '1.08' } }];
  assert.equal(computeOpenRiskUSD(trades), 1000);
  assert.equal(computeOpenRiskPercent(trades, 10000), 10);
});

test('open trades with no stop contribute zero quantifiable risk', () => {
  const trades = [{ instrument: 'EUR_USD', currentUnits: '50000', price: '1.10' }];
  assert.equal(computeOpenRiskUSD(trades), 0);
});
