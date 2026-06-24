import { test } from 'node:test';
import assert from 'node:assert/strict';

// dailyTradeCap() reads env at CALL time, so we can exercise several configs in
// one process by setting/clearing the vars per case.
const { dailyTradeCap, isDailyTradeCapReached } = await import('./oandaTrade.js');

function clearCapEnv() {
  delete process.env.AUTO_AI_DAILY_TRADE_CAP;
  delete process.env.FOREX_MAX_DAILY_TRADES;
}

test('default daily trade cap is 10 (not 3)', () => {
  clearCapEnv();
  assert.equal(dailyTradeCap(), 10);
});

test('AUTO_AI_DAILY_TRADE_CAP drives the cap', () => {
  clearCapEnv();
  process.env.AUTO_AI_DAILY_TRADE_CAP = '15';
  assert.equal(dailyTradeCap(), 15);
  clearCapEnv();
});

test('legacy FOREX_MAX_DAILY_TRADES still works as a fallback', () => {
  clearCapEnv();
  process.env.FOREX_MAX_DAILY_TRADES = '7';
  assert.equal(dailyTradeCap(), 7);
  clearCapEnv();
});

test('AUTO_AI_DAILY_TRADE_CAP takes precedence over the legacy var', () => {
  clearCapEnv();
  process.env.AUTO_AI_DAILY_TRADE_CAP = '10';
  process.env.FOREX_MAX_DAILY_TRADES = '3';
  assert.equal(dailyTradeCap(), 10);
  clearCapEnv();
});

test('safety guard blocks at 10/10, not 3/3', () => {
  clearCapEnv(); // default cap 10
  assert.equal(isDailyTradeCapReached(2), false);  // old 3-cap would have blocked at 3
  assert.equal(isDailyTradeCapReached(3), false);
  assert.equal(isDailyTradeCapReached(9), false);  // 10th trade still allowed
  assert.equal(isDailyTradeCapReached(10), true);  // blocks at 10/10
  assert.equal(isDailyTradeCapReached(11), true);
});
