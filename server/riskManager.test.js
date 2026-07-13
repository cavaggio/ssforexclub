import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pin the central caps to their documented defaults (1.4% / 2.8% / 85).
delete process.env.RISK_MAX_PER_TRADE_PERCENT;
delete process.env.RISK_DAILY_MAX_DRAWDOWN_PERCENT;
delete process.env.RISK_AUTO_EXECUTION_MIN_CONFIDENCE;

const {
  riskConfig,
  computeRiskBudgetUSD,
  capPerTradeRiskPercent,
  checkRiskPerTrade,
  checkDailyRiskLock,
  resetDailyRisk,
  checkAutoExecutionConfidence,
  checkMargin,
  getRiskStatus,
  MARGIN_RESTRICTION_MESSAGE,
} = await import('./riskManager.js');

const NOW = new Date('2026-06-10T15:00:00Z');

test('defaults are 1.4% per trade, 2.8% daily drawdown, 85 confidence', () => {
  const cfg = riskConfig();
  assert.equal(cfg.maxRiskPerTradePercent, 1.4);
  assert.equal(cfg.dailyMaxDrawdownPercent, 2.8);
  assert.equal(cfg.autoExecutionMinConfidence, 85);
});

// ── 1. Risk per trade (1.4% hard cap) ───────────────────────────────────────

test('risk budget is 1.4% of balance', () => {
  assert.equal(computeRiskBudgetUSD(10000), 140);
});

test('per-trade risk percent is clamped to 1.4%', () => {
  assert.equal(capPerTradeRiskPercent(2.0), 1.4);
  assert.equal(capPerTradeRiskPercent(1.0), 1.0);
});

test('actual risk at exactly 1.4% is allowed', () => {
  const r = checkRiskPerTrade({ balanceUSD: 10000, actualDollarRisk: 140 });
  assert.equal(r.passed, true);
});

test('actual risk above 1.4% is rejected', () => {
  // $200 on a $10k account = 2% > 1.4% cap (beyond the rounding tolerance).
  const r = checkRiskPerTrade({ balanceUSD: 10000, actualDollarRisk: 200 });
  assert.equal(r.passed, false);
  assert.match(r.reason, /exceeds hard cap 1\.4%/);
});

// ── 2. Daily max-drawdown circuit breaker (2.8%) ────────────────────────────

test('daily realized loss within 2.8% keeps trading unlocked', () => {
  resetDailyRisk();
  // First observation sets the day's starting balance.
  checkDailyRiskLock({ accountId: 'ACC-A', balanceUSD: 10000, now: NOW });
  // Down $200 (2%) — still under the $280 (2.8%) limit.
  const r = checkDailyRiskLock({ accountId: 'ACC-A', balanceUSD: 9800, now: NOW });
  assert.equal(r.tradingLocked, false);
  assert.equal(r.startingBalance, 10000);
  assert.equal(r.lossLimit, 280);
});

test('daily realized loss beyond 2.8% locks new entries', () => {
  resetDailyRisk();
  checkDailyRiskLock({ accountId: 'ACC-B', balanceUSD: 10000, now: NOW });
  // Down $300 (3%) — breaches the $280 (2.8%) limit.
  const r = checkDailyRiskLock({ accountId: 'ACC-B', balanceUSD: 9700, now: NOW });
  assert.equal(r.tradingLocked, true);
  assert.match(r.reason, /Daily drawdown limit reached/);
});

test('daily lock is per-account (one account locking does not lock another)', () => {
  resetDailyRisk();
  checkDailyRiskLock({ accountId: 'ACC-LOCK', balanceUSD: 10000, now: NOW });
  const locked = checkDailyRiskLock({ accountId: 'ACC-LOCK', balanceUSD: 9600, now: NOW });
  const other = checkDailyRiskLock({ accountId: 'ACC-FREE', balanceUSD: 10000, now: NOW });
  assert.equal(locked.tradingLocked, true);
  assert.equal(other.tradingLocked, false);
});

test('daily baseline resets at the New York day rollover', () => {
  resetDailyRisk();
  const day1 = new Date('2026-06-10T15:00:00Z');
  const day2 = new Date('2026-06-11T15:00:00Z');
  checkDailyRiskLock({ accountId: 'ACC-R', balanceUSD: 10000, now: day1 });
  const lockedDay1 = checkDailyRiskLock({ accountId: 'ACC-R', balanceUSD: 9600, now: day1 });
  assert.equal(lockedDay1.tradingLocked, true);
  // New NY day → baseline re-anchors to the current balance → unlocked.
  const day2Status = checkDailyRiskLock({ accountId: 'ACC-R', balanceUSD: 9600, now: day2 });
  assert.equal(day2Status.tradingLocked, false);
  assert.equal(day2Status.startingBalance, 9600);
});

// ── 3. Auto execution confidence floor (85) ─────────────────────────────────

test('confidence at 85 passes the auto-execution floor', () => {
  assert.equal(checkAutoExecutionConfidence(85).passed, true);
});

test('confidence below 85 fails the auto-execution floor', () => {
  const r = checkAutoExecutionConfidence(84);
  assert.equal(r.passed, false);
  assert.match(r.reason, /floor 85%/);
});

// ── 4. Margin ───────────────────────────────────────────────────────────────

test('insufficient margin is blocked with the exact message', () => {
  const r = checkMargin({ marginAvailable: 100, estimatedMargin: 500 });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, MARGIN_RESTRICTION_MESSAGE);
  assert.equal(r.reason, 'Account margin restriction would be exceeded.');
});

// ── 5. Dashboard status ──────────────────────────────────────────────────────

test('getRiskStatus surfaces the documented panel fields', () => {
  resetDailyRisk();
  const s = getRiskStatus({ accountId: 'ACC-S', balanceUSD: 10000, now: NOW });
  assert.equal(s.accountBalance, 10000);
  assert.equal(s.riskPerTradePercent, 1.4);
  assert.equal(s.riskAmountUSD, 140);
  assert.equal(s.dailyLossLimitPercent, 2.8);
  assert.equal(s.dailyLossLimitUSD, 280);
  assert.equal(s.autoExecutionConfidenceThreshold, 85);
  assert.equal(s.tradingLocked, false);
});
