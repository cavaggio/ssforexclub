import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pin the central caps to their documented defaults (1.4% / 2.8% / 90).
delete process.env.RISK_MAX_PER_TRADE_PERCENT;
delete process.env.RISK_DAILY_MAX_DRAWDOWN_PERCENT;
delete process.env.RISK_AUTO_EXECUTION_MIN_CONFIDENCE;
delete process.env.RISK_CONSERVATIVE_TRIGGER_PERCENT;
delete process.env.RISK_CONSERVATIVE_MIN_CONFIDENCE;
delete process.env.RISK_MAX_STOP_LOSS_PIPS;

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
  clampUnitsToRiskBudget,
  validateStopLoss,
  resolveActiveConfidenceThreshold,
  checkConservativeCorrelatedExposure,
  MARGIN_RESTRICTION_MESSAGE,
} = await import('./riskManager.js');

const NOW = new Date('2026-06-10T15:00:00Z');

test('defaults are 1.4% per trade, 2.8% daily drawdown, 90 confidence', () => {
  const cfg = riskConfig();
  assert.equal(cfg.maxRiskPerTradePercent, 1.4);
  assert.equal(cfg.dailyMaxDrawdownPercent, 2.8);
  assert.equal(cfg.autoExecutionMinConfidence, 90);
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

// ── Unit clamp — dynamic sizing can never exceed 1.4% (reduce or reject) ─────

test('dynamic mode cannot exceed 1.4%: over-budget units are reduced', () => {
  // balance $10k → budget $140. riskPerUnit $0.002 → a 2% ($200) ask = 100k units.
  const r = clampUnitsToRiskBudget({ balanceUSD: 10000, requestedUnits: 100000, riskPerUnitUSD: 0.002 });
  assert.equal(r.ok, true);
  assert.equal(r.reduced, true);
  assert.equal(r.maxUnits, 70000);          // 140 / 0.002
  assert.ok(r.riskUSD <= 140 + 1e-9, `risk ${r.riskUSD} must be ≤ $140`);
});

test('units already within 1.4% are not reduced', () => {
  const r = clampUnitsToRiskBudget({ balanceUSD: 10000, requestedUnits: 50000, riskPerUnitUSD: 0.002 });
  assert.equal(r.ok, true);
  assert.equal(r.reduced, false);
  assert.equal(r.units, 50000);
});

test('a stop so wide it cannot size ≥1 unit at 1.4% is rejected (not loosened)', () => {
  // riskPerUnit $200 > whole $140 budget → maxUnits 0 → reject.
  const r = clampUnitsToRiskBudget({ balanceUSD: 10000, requestedUnits: 1, riskPerUnitUSD: 200 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /too wide|rejected/i);
});

test('unpriceable stop (zero risk per unit) is rejected', () => {
  const r = clampUnitsToRiskBudget({ balanceUSD: 10000, requestedUnits: 1000, riskPerUnitUSD: 0 });
  assert.equal(r.ok, false);
});

// ── Stop-loss validation ─────────────────────────────────────────────────────

test('missing/invalid/zero stop loss is rejected; a valid one passes', () => {
  assert.equal(validateStopLoss({ entry: 1.1, stopLoss: NaN, direction: 'long', stopLossPips: 20 }).valid, false);
  // long stop above entry = wrong side
  assert.equal(validateStopLoss({ entry: 1.1, stopLoss: 1.12, direction: 'long', stopLossPips: 20 }).valid, false);
  assert.equal(validateStopLoss({ entry: 1.1, stopLoss: 1.098, direction: 'long', stopLossPips: 0 }).valid, false);
  assert.equal(validateStopLoss({ entry: 1.1, stopLoss: 1.098, direction: 'long', stopLossPips: 20 }).valid, true);
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

test('daily loss limit is anchored to STARTING balance, not current balance', () => {
  resetDailyRisk();
  // Baseline $10k → limit fixed at $280 (2.8% of 10k) all day.
  const s0 = checkDailyRiskLock({ accountId: 'ACC-FIX', balanceUSD: 10000, now: NOW });
  assert.equal(s0.lossLimit, 280);
  // Balance drops to $9,700 — limit must STILL be $280 (not 2.8% of 9,700 = $271.60).
  const s1 = checkDailyRiskLock({ accountId: 'ACC-FIX', balanceUSD: 9700, now: NOW });
  assert.equal(s1.lossLimit, 280);
  assert.equal(s1.startingBalance, 10000);
  assert.equal(s1.realizedPnL, -300);
});

// ── 4. Progressive risk tightening (conservative mode at 1.4% realized loss) ─

test('after 1.4% realized daily loss the auto threshold becomes 95%', () => {
  resetDailyRisk();
  checkDailyRiskLock({ accountId: 'ACC-CONS', balanceUSD: 10000, now: NOW }); // baseline 10k
  // Down $140 (1.4%) → conservative mode, threshold 95, but NOT yet locked (< 2.8%).
  const s = checkDailyRiskLock({ accountId: 'ACC-CONS', balanceUSD: 9860, now: NOW });
  assert.equal(s.conservativeMode, true);
  assert.equal(s.tradingLocked, false);
  assert.equal(s.activeConfidenceThreshold, 95);
});

test('below the 1.4% trigger the threshold stays 90 (standard mode)', () => {
  resetDailyRisk();
  checkDailyRiskLock({ accountId: 'ACC-STD', balanceUSD: 10000, now: NOW });
  const s = checkDailyRiskLock({ accountId: 'ACC-STD', balanceUSD: 9900, now: NOW }); // -1.0%
  assert.equal(s.conservativeMode, false);
  assert.equal(s.activeConfidenceThreshold, 90);
});

test('resolveActiveConfidenceThreshold reflects conservative mode per account', () => {
  resetDailyRisk();
  checkDailyRiskLock({ accountId: 'ACC-RT', balanceUSD: 10000, now: NOW });
  checkDailyRiskLock({ accountId: 'ACC-RT', balanceUSD: 9850, now: NOW }); // -1.5% → conservative
  const r = resolveActiveConfidenceThreshold({ accountId: 'ACC-RT', balanceUSD: 9850, now: NOW });
  assert.equal(r.conservativeMode, true);
  assert.equal(r.threshold, 95);
});

// ── 3. Auto execution confidence floor (90 / dynamic 95) ─────────────────────

test('confidence at 90 passes the auto-execution floor', () => {
  assert.equal(checkAutoExecutionConfidence(90).passed, true);
});

test('confidence below 90 fails the auto-execution floor', () => {
  const r = checkAutoExecutionConfidence(89);
  assert.equal(r.passed, false);
  assert.match(r.reason, /floor 90%/);
});

test('in conservative mode a 92% confidence trade is rejected (needs 95%)', () => {
  resetDailyRisk();
  checkDailyRiskLock({ accountId: 'ACC-C95', balanceUSD: 10000, now: NOW });
  checkDailyRiskLock({ accountId: 'ACC-C95', balanceUSD: 9850, now: NOW }); // -1.5% → conservative
  const r = checkAutoExecutionConfidence(92, { accountId: 'ACC-C95', balanceUSD: 9850, now: NOW });
  assert.equal(r.passed, false);
  assert.equal(r.required, 95);
  assert.equal(r.conservativeMode, true);
});

// ── Conservative-mode correlated-exposure guard ──────────────────────────────

test('conservative mode blocks a new trade that reinforces existing exposure', () => {
  const open = [{ instrument: 'EUR_GBP', direction: 'long' }]; // long EUR
  const r = checkConservativeCorrelatedExposure({ conservativeMode: true, pair: 'EUR_USD', direction: 'long', openTrades: open });
  assert.equal(r.allowed, false); // both add EUR-long exposure
});

test('outside conservative mode the correlation guard is a no-op', () => {
  const open = [{ instrument: 'EUR_GBP', direction: 'long' }];
  const r = checkConservativeCorrelatedExposure({ conservativeMode: false, pair: 'EUR_USD', direction: 'long', openTrades: open });
  assert.equal(r.allowed, true);
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
  assert.equal(s.currentBalance, 10000);
  assert.equal(s.riskPerTradePercent, 1.4);
  assert.equal(s.riskAmountUSD, 140);
  assert.equal(s.dailyLossLimitPercent, 2.8);
  assert.equal(s.dailyLossLimitUSD, 280);
  assert.equal(s.autoExecutionConfidenceThreshold, 90);
  assert.equal(s.currentAutoConfidenceThreshold, 90);
  assert.equal(s.conservativeMode, false);
  assert.equal(s.tradingLocked, false);
  assert.equal(s.lastRejectedReason, null);
});

test('getRiskStatus reflects conservative mode + the active 95% threshold', () => {
  resetDailyRisk();
  getRiskStatus({ accountId: 'ACC-S2', balanceUSD: 10000, now: NOW });        // baseline 10k
  const s = getRiskStatus({ accountId: 'ACC-S2', balanceUSD: 9850, now: NOW }); // -1.5%
  assert.equal(s.conservativeMode, true);
  assert.equal(s.currentAutoConfidenceThreshold, 95);
});
