import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pin the central caps to their documented defaults (1% / 2% / 0.5% after loss / 85).
delete process.env.RISK_MAX_PER_TRADE_PERCENT;
delete process.env.RISK_DAILY_MAX_DRAWDOWN_PERCENT;
delete process.env.RISK_POST_LOSS_NEXT_TRADE_PERCENT;
delete process.env.RISK_AUTO_EXECUTION_MIN_CONFIDENCE;

const {
  riskConfig,
  computeRiskBudgetUSD,
  capPerTradeRiskPercent,
  checkRiskPerTrade,
  checkDailyRiskLock,
  reserveDailyLossBudget,
  hydrateDailyRiskState,
  persistDailyRiskState,
  markTradeOpened,
  recordRealizedTradeResult,
  resetDailyRisk,
  checkAutoExecutionConfidence,
  checkMargin,
  getRiskStatus,
  __setRiskPersistenceForTests,
  __resetRiskMemoryForTests,
  MARGIN_RESTRICTION_MESSAGE,
} = await import('./riskManager.js');

const NOW = new Date('2026-06-10T15:00:00Z');

test('defaults are 1% per trade, 2% daily drawdown, 0.5% post-loss, and 85 confidence', () => {
  const cfg = riskConfig();
  assert.equal(cfg.maxRiskPerTradePercent, 1);
  assert.equal(cfg.dailyMaxDrawdownPercent, 2);
  assert.equal(cfg.postLossRiskPercent, 0.5);
  assert.equal(cfg.autoExecutionMinConfidence, 85);
});

test('environment variables cannot raise risk above the hard policy', () => {
  process.env.RISK_MAX_PER_TRADE_PERCENT = '1.25';
  process.env.RISK_DAILY_MAX_DRAWDOWN_PERCENT = '2.5';
  process.env.RISK_POST_LOSS_NEXT_TRADE_PERCENT = '0.75';
  const cfg = riskConfig();
  assert.equal(cfg.maxRiskPerTradePercent, 1);
  assert.equal(cfg.dailyMaxDrawdownPercent, 2);
  assert.equal(cfg.postLossRiskPercent, 0.5);
  delete process.env.RISK_MAX_PER_TRADE_PERCENT;
  delete process.env.RISK_DAILY_MAX_DRAWDOWN_PERCENT;
  delete process.env.RISK_POST_LOSS_NEXT_TRADE_PERCENT;
});

test('risk budget is 1% of balance', () => {
  assert.equal(computeRiskBudgetUSD(10000), 100);
});

test('per-trade risk percent is clamped to 1%', () => {
  assert.equal(capPerTradeRiskPercent(2), 1);
  assert.equal(capPerTradeRiskPercent(0.75), 0.75);
});

test('actual risk at exactly 1% is allowed', () => {
  const result = checkRiskPerTrade({ balanceUSD: 10000, actualDollarRisk: 100 });
  assert.equal(result.passed, true);
});

test('actual risk above 1% is rejected', () => {
  const result = checkRiskPerTrade({ balanceUSD: 10000, actualDollarRisk: 125 });
  assert.equal(result.passed, false);
  assert.match(result.reason, /exceeds hard cap 1%/);
});

test('daily realized loss below 2% keeps trading unlocked', () => {
  resetDailyRisk();
  checkDailyRiskLock({ accountId: 'ACC-A', balanceUSD: 10000, now: NOW });
  const result = checkDailyRiskLock({ accountId: 'ACC-A', balanceUSD: 9801, now: NOW });
  assert.equal(result.tradingLocked, false);
  assert.equal(result.startingBalance, 10000);
  assert.equal(result.lossLimit, 200);
});

test('daily realized loss at 2% locks new entries', () => {
  resetDailyRisk();
  checkDailyRiskLock({ accountId: 'ACC-B', balanceUSD: 10000, now: NOW });
  const result = checkDailyRiskLock({ accountId: 'ACC-B', balanceUSD: 9800, now: NOW });
  assert.equal(result.tradingLocked, true);
  assert.match(result.reason, /Auto-trading is locked/);
});

test('daily lock remains latched after the threshold is hit', () => {
  resetDailyRisk();
  checkDailyRiskLock({ accountId: 'ACC-LATCH', balanceUSD: 10000, now: NOW });
  assert.equal(checkDailyRiskLock({ accountId: 'ACC-LATCH', balanceUSD: 9800, now: NOW }).tradingLocked, true);
  const recoveredBalance = checkDailyRiskLock({ accountId: 'ACC-LATCH', balanceUSD: 9950, now: NOW });
  assert.equal(recoveredBalance.tradingLocked, true);
  assert.equal(recoveredBalance.remainingLossBudget, 0);
});

test('daily lock is per-account', () => {
  resetDailyRisk();
  checkDailyRiskLock({ accountId: 'ACC-LOCK', balanceUSD: 10000, now: NOW });
  const locked = checkDailyRiskLock({ accountId: 'ACC-LOCK', balanceUSD: 9700, now: NOW });
  const other = checkDailyRiskLock({ accountId: 'ACC-FREE', balanceUSD: 10000, now: NOW });
  assert.equal(locked.tradingLocked, true);
  assert.equal(other.tradingLocked, false);
});

test('daily baseline resets at the New York day rollover', () => {
  resetDailyRisk();
  const day1 = new Date('2026-06-10T15:00:00Z');
  const day2 = new Date('2026-06-11T15:00:00Z');
  checkDailyRiskLock({ accountId: 'ACC-R', balanceUSD: 10000, now: day1 });
  const lockedDay1 = checkDailyRiskLock({ accountId: 'ACC-R', balanceUSD: 9700, now: day1 });
  assert.equal(lockedDay1.tradingLocked, true);
  const day2Status = checkDailyRiskLock({ accountId: 'ACC-R', balanceUSD: 9700, now: day2 });
  assert.equal(day2Status.tradingLocked, false);
  assert.equal(day2Status.startingBalance, 9700);
});

test('the next filled trade after a realized loss is capped at 0.5%, then returns to 1%', () => {
  resetDailyRisk();
  checkDailyRiskLock({ accountId: 'ACC-RECOVERY', balanceUSD: 10000, now: NOW });
  checkDailyRiskLock({ accountId: 'ACC-RECOVERY', balanceUSD: 9900, now: NOW });

  const recovery = reserveDailyLossBudget({
    accountId: 'ACC-RECOVERY', balanceUSD: 9900, requestedRiskUSD: 100, now: NOW,
  });
  assert.equal(recovery.allowed, true);
  assert.equal(recovery.recoveryTrade, true);
  assert.equal(recovery.riskPercentApplied, 0.5);
  assert.equal(recovery.approvedRiskUSD, 49.5);

  const consumed = markTradeOpened({ accountId: 'ACC-RECOVERY', balanceUSD: 9900, now: NOW });
  assert.equal(consumed.consumedRecoveryRisk, true);

  const standard = reserveDailyLossBudget({
    accountId: 'ACC-RECOVERY', balanceUSD: 9900, requestedRiskUSD: 100, now: NOW,
  });
  assert.equal(standard.recoveryTrade, false);
  assert.equal(standard.riskPercentApplied, 1);
  assert.equal(standard.approvedRiskUSD, 99);
});

test('transaction synchronization can explicitly arm post-loss sizing', () => {
  resetDailyRisk();
  checkDailyRiskLock({ accountId: 'ACC-TX', balanceUSD: 10000, now: NOW });
  const state = recordRealizedTradeResult({
    accountId: 'ACC-TX', realizedPnL: -50, balanceUSD: 9950, now: NOW,
  });
  assert.equal(state.recoveryTradesRemaining, 1);
  assert.equal(state.nextTradeRiskPercent, 0.5);
});

test('daily lock and pending 0.5% recovery sizing survive a process restart', async () => {
  const rows = new Map();
  const adapter = {
    async load(accountId, dayKey) {
      return rows.get(`${accountId}:${dayKey}`) || null;
    },
    async save(row) {
      rows.set(`${row.account_id}:${row.risk_date}`, structuredClone(row));
    },
    async clear(accountId, dayKey) {
      for (const key of [...rows.keys()]) {
        if ((accountId == null || key.startsWith(`${accountId}:`)) && (dayKey == null || key.endsWith(`:${dayKey}`))) {
          rows.delete(key);
        }
      }
    },
  };

  __setRiskPersistenceForTests(adapter);
  __resetRiskMemoryForTests();
  await hydrateDailyRiskState({ accountId: 'ACC-PERSIST', balanceUSD: 10000, now: NOW });
  checkDailyRiskLock({ accountId: 'ACC-PERSIST', balanceUSD: 9800, now: NOW });
  await persistDailyRiskState({ accountId: 'ACC-PERSIST', balanceUSD: 9800, now: NOW });

  __resetRiskMemoryForTests();
  await hydrateDailyRiskState({ accountId: 'ACC-PERSIST', balanceUSD: 9900, now: NOW });
  assert.equal(checkDailyRiskLock({ accountId: 'ACC-PERSIST', balanceUSD: 9900, now: NOW }).tradingLocked, true);

  __resetRiskMemoryForTests();
  rows.clear();
  await hydrateDailyRiskState({ accountId: 'ACC-RECOVERY-PERSIST', balanceUSD: 10000, now: NOW });
  checkDailyRiskLock({ accountId: 'ACC-RECOVERY-PERSIST', balanceUSD: 9900, now: NOW });
  await persistDailyRiskState({ accountId: 'ACC-RECOVERY-PERSIST', balanceUSD: 9900, now: NOW });

  __resetRiskMemoryForTests();
  await hydrateDailyRiskState({ accountId: 'ACC-RECOVERY-PERSIST', balanceUSD: 9900, now: NOW });
  const recovery = reserveDailyLossBudget({
    accountId: 'ACC-RECOVERY-PERSIST', balanceUSD: 9900, requestedRiskUSD: 100, now: NOW,
  });
  assert.equal(recovery.recoveryTrade, true);
  assert.equal(recovery.riskPercentApplied, 0.5);

  __resetRiskMemoryForTests();
  __setRiskPersistenceForTests(null);
});

test('confidence at 85 passes the auto-execution floor', () => {
  assert.equal(checkAutoExecutionConfidence(85).passed, true);
});

test('confidence below 85 fails the auto-execution floor', () => {
  const result = checkAutoExecutionConfidence(84);
  assert.equal(result.passed, false);
  assert.match(result.reason, /floor 85%/);
});

test('insufficient margin is blocked with the exact message', () => {
  const result = checkMargin({ marginAvailable: 100, estimatedMargin: 500 });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, MARGIN_RESTRICTION_MESSAGE);
  assert.equal(result.reason, 'Account margin restriction would be exceeded.');
});

test('dashboard status surfaces current and next-trade risk policy', () => {
  resetDailyRisk();
  const status = getRiskStatus({ accountId: 'ACC-S', balanceUSD: 10000, now: NOW });
  assert.equal(status.accountBalance, 10000);
  assert.equal(status.riskPerTradePercent, 1);
  assert.equal(status.riskAmountUSD, 100);
  assert.equal(status.nextTradeRiskPercent, 1);
  assert.equal(status.postLossRiskPercent, 0.5);
  assert.equal(status.dailyLossLimitPercent, 2);
  assert.equal(status.dailyLossLimitUSD, 200);
  assert.equal(status.autoExecutionConfidenceThreshold, 85);
  assert.equal(status.tradingLocked, false);
});
