/**
 * server/riskManager.js
 *
 * Central risk policy for every automated forex engine.
 *
 * Controls:
 *   1. Maximum risk per trade: 1% of current balance.
 *   2. Daily realized-loss lock: 2% of the New York day's starting balance.
 *   3. The first filled trade after a realized loss is reduced to 0.5% risk.
 *   4. Auto-execution confidence and margin guards remain centralized here.
 */

export const MARGIN_RESTRICTION_MESSAGE = 'Account margin restriction would be exceeded.';
const RISK_TOLERANCE = 0.005;
const BALANCE_TOLERANCE_USD = 0.01;

function boundedPositive(value, fallback, maximum) {
  const parsed = Number(value);
  const safe = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.min(maximum, safe);
}

export function riskConfig() {
  return {
    maxRiskPerTradePercent: boundedPositive(process.env.RISK_MAX_PER_TRADE_PERCENT, 1, 1),
    dailyMaxDrawdownPercent: boundedPositive(process.env.RISK_DAILY_MAX_DRAWDOWN_PERCENT, 2, 2),
    postLossRiskPercent: boundedPositive(process.env.RISK_POST_LOSS_NEXT_TRADE_PERCENT, 0.5, 0.5),
    autoExecutionMinConfidence: Math.max(
      85,
      parseFloat(process.env.RISK_AUTO_EXECUTION_MIN_CONFIDENCE || process.env.FOREX_MIN_CONFIDENCE || '85'),
    ),
  };
}

export function computeRiskBudgetUSD(balanceUSD, cfg = riskConfig()) {
  const balance = Number(balanceUSD);
  if (!Number.isFinite(balance) || balance <= 0) return 0;
  return +(balance * (cfg.maxRiskPerTradePercent / 100)).toFixed(2);
}

export function capPerTradeRiskPercent(requestedRiskPercent, cfg = riskConfig()) {
  const max = cfg.maxRiskPerTradePercent;
  if (!Number.isFinite(requestedRiskPercent) || requestedRiskPercent <= 0) return max;
  return Math.min(requestedRiskPercent, max);
}

export function checkRiskPerTrade({ balanceUSD, actualDollarRisk, stopLossPips = null, positionSize = null }, cfg = riskConfig()) {
  const balance = Number(balanceUSD);
  const actual = Number(actualDollarRisk);
  const riskAmount = computeRiskBudgetUSD(balance, cfg);
  const ceiling = riskAmount * (1 + RISK_TOLERANCE);
  const passed = Number.isFinite(balance) && balance > 0 &&
    Number.isFinite(actual) && actual >= 0 && actual <= ceiling;
  const actualRiskPercent = (Number.isFinite(actual) && balance > 0)
    ? +((actual / balance) * 100).toFixed(4)
    : null;
  console.log(
    `[RISK CHECK]\n` +
    `balance=${Number.isFinite(balance) ? balance.toFixed(2) : 'n/a'}\n` +
    `riskAmount=${riskAmount.toFixed(2)}\n` +
    `stopLossPips=${stopLossPips ?? 'n/a'}\n` +
    `positionSize=${positionSize ?? 'n/a'}\n` +
    `actualRisk=${Number.isFinite(actual) ? actual.toFixed(2) : 'n/a'}\n` +
    `passed=${passed}`
  );
  if (passed) return { passed: true, riskAmount, actualRiskPercent, maxRiskPercent: cfg.maxRiskPerTradePercent };
  return {
    passed: false,
    riskAmount,
    actualRiskPercent,
    maxRiskPercent: cfg.maxRiskPerTradePercent,
    reason: `Risk per trade $${Number.isFinite(actual) ? actual.toFixed(2) : '?'} ` +
      `exceeds hard cap ${cfg.maxRiskPerTradePercent}% ($${riskAmount.toFixed(2)}) of balance.`,
  };
}

// accountId → {
//   dayKey, startingBalance, lastObservedBalance, recoveryTradesRemaining
// }
const dailyState = new Map();

function nyDateKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function accountKey(accountId) {
  return accountId ? String(accountId) : '__default__';
}

function observeRealizedBalance(state, balance) {
  if (!Number.isFinite(balance)) return state;
  const previous = Number(state.lastObservedBalance);
  if (Number.isFinite(previous) && balance < previous - BALANCE_TOLERANCE_USD) {
    state.recoveryTradesRemaining = 1;
    state.lastLossDetectedAt = new Date().toISOString();
    console.log(
      `[POST_LOSS_RISK] realized balance decreased ${previous.toFixed(2)} → ${balance.toFixed(2)}; ` +
      'next filled trade will use 0.5% risk',
    );
  }
  state.lastObservedBalance = balance;
  return state;
}

export function ensureDailyBaseline({ accountId, balanceUSD, now = new Date() }) {
  const key = accountKey(accountId);
  const dayKey = nyDateKey(now);
  const balance = Number(balanceUSD);
  const prev = dailyState.get(key);
  if (!prev || prev.dayKey !== dayKey) {
    const startingBalance = Number.isFinite(balance) ? balance : (prev?.startingBalance ?? 0);
    const next = {
      dayKey,
      startingBalance,
      lastObservedBalance: Number.isFinite(balance) ? balance : startingBalance,
      recoveryTradesRemaining: 0,
      lastLossDetectedAt: null,
    };
    dailyState.set(key, next);
    return next;
  }
  if ((!Number.isFinite(prev.startingBalance) || prev.startingBalance <= 0) && Number.isFinite(balance)) {
    prev.startingBalance = balance;
  }
  observeRealizedBalance(prev, balance);
  return prev;
}

export function recordRealizedTradeResult({ accountId, realizedPnL, balanceUSD, now = new Date() } = {}) {
  const state = ensureDailyBaseline({ accountId, balanceUSD, now });
  const pnl = Number(realizedPnL);
  if (Number.isFinite(pnl) && pnl < 0) {
    state.recoveryTradesRemaining = 1;
    state.lastLossDetectedAt = now.toISOString();
  }
  if (Number.isFinite(Number(balanceUSD))) state.lastObservedBalance = Number(balanceUSD);
  return {
    recoveryTradesRemaining: state.recoveryTradesRemaining,
    nextTradeRiskPercent: state.recoveryTradesRemaining > 0 ? riskConfig().postLossRiskPercent : riskConfig().maxRiskPerTradePercent,
  };
}

export function effectiveRiskPercentForAccount({ accountId, balanceUSD, now = new Date() } = {}, cfg = riskConfig()) {
  const state = ensureDailyBaseline({ accountId, balanceUSD, now });
  return state.recoveryTradesRemaining > 0
    ? Math.min(cfg.postLossRiskPercent, cfg.maxRiskPerTradePercent)
    : cfg.maxRiskPerTradePercent;
}

export function markTradeOpened({ accountId, balanceUSD, now = new Date() } = {}) {
  const state = ensureDailyBaseline({ accountId, balanceUSD, now });
  const consumedRecoveryRisk = state.recoveryTradesRemaining > 0;
  if (consumedRecoveryRisk) {
    state.recoveryTradesRemaining = Math.max(0, state.recoveryTradesRemaining - 1);
    console.log('[POST_LOSS_RISK] 0.5% recovery trade filled; standard 1% risk restored for the next trade');
  }
  return { consumedRecoveryRisk, recoveryTradesRemaining: state.recoveryTradesRemaining };
}

export function checkDailyRiskLock({ accountId, balanceUSD, now = new Date() }, cfg = riskConfig()) {
  const state = ensureDailyBaseline({ accountId, balanceUSD, now });
  const startingBalance = Number(state.startingBalance) || 0;
  const balance = Number.isFinite(Number(balanceUSD)) ? Number(balanceUSD) : startingBalance;
  const lossLimit = +(startingBalance * (cfg.dailyMaxDrawdownPercent / 100)).toFixed(2);
  const realizedPnL = +(balance - startingBalance).toFixed(2);
  const tradingLocked = lossLimit > 0 && realizedPnL <= -lossLimit;
  const remainingLossBudget = +Math.max(0, lossLimit + realizedPnL).toFixed(2);
  console.log(
    `[DAILY RISK LOCK]\n` +
    `startingBalance=${startingBalance.toFixed(2)}\n` +
    `realizedPnL=${realizedPnL.toFixed(2)}\n` +
    `lossLimit=${lossLimit.toFixed(2)}\n` +
    `tradingLocked=${tradingLocked}`
  );
  return {
    tradingLocked,
    startingBalance,
    realizedPnL,
    lossLimit,
    remainingLossBudget,
    dailyMaxDrawdownPercent: cfg.dailyMaxDrawdownPercent,
    recoveryTradesRemaining: state.recoveryTradesRemaining,
    nextTradeRiskPercent: state.recoveryTradesRemaining > 0 ? cfg.postLossRiskPercent : cfg.maxRiskPerTradePercent,
    reason: tradingLocked
      ? `Daily drawdown limit reached: realized P&L $${realizedPnL.toFixed(2)} ` +
        `breached -$${lossLimit.toFixed(2)} (${cfg.dailyMaxDrawdownPercent}% of $${startingBalance.toFixed(2)}). ` +
        `Auto-trading is locked until the New York midnight reset; open trades keep being managed.`
      : null,
  };
}

export function reserveDailyLossBudget({ accountId, balanceUSD, openRiskUSD = 0, requestedRiskUSD = 0, now = new Date() } = {}) {
  const cfg = riskConfig();
  const lock = checkDailyRiskLock({ accountId, balanceUSD, now }, cfg);
  const balance = Number(balanceUSD);
  const openRisk = Math.max(0, Number(openRiskUSD) || 0);
  const requested = Math.max(0, Number(requestedRiskUSD) || 0);
  const appliedRiskPercent = effectiveRiskPercentForAccount({ accountId, balanceUSD, now }, cfg);
  const perTradeLimitUSD = Number.isFinite(balance) && balance > 0
    ? +(balance * (appliedRiskPercent / 100)).toFixed(2)
    : 0;
  const policyRequested = Math.min(requested, perTradeLimitUSD);
  const remainingAfterOpenRisk = Math.max(0, lock.remainingLossBudget - openRisk);
  const approvedRiskUSD = Math.floor(Math.min(policyRequested, remainingAfterOpenRisk) * 100) / 100;
  return {
    allowed: !lock.tradingLocked && approvedRiskUSD > 0,
    capped: approvedRiskUSD + 0.005 < requested,
    approvedRiskUSD,
    requestedRiskUSD: requested,
    openRiskUSD: openRisk,
    remainingDailyBudgetUSD: lock.remainingLossBudget,
    remainingAfterOpenRiskUSD: remainingAfterOpenRisk,
    riskPercentApplied: appliedRiskPercent,
    perTradeLimitUSD,
    recoveryTrade: appliedRiskPercent === cfg.postLossRiskPercent,
    reason: lock.tradingLocked
      ? lock.reason
      : approvedRiskUSD <= 0
        ? 'No uncommitted daily loss budget remains.'
        : null,
  };
}

export function resetDailyRisk() {
  const cleared = dailyState.size;
  dailyState.clear();
  console.log(`[DAILY RISK LOCK] reset — cleared ${cleared} account baseline(s)`);
  return { ok: true, cleared };
}

export function checkAutoExecutionConfidence(confidence, cfg = riskConfig()) {
  const required = cfg.autoExecutionMinConfidence;
  const conf = Number(confidence);
  const passed = Number.isFinite(conf) && conf >= required;
  console.log(
    `[AUTO EXECUTION FILTER]\n` +
    `confidence=${Number.isFinite(conf) ? conf : 'n/a'}\n` +
    `required=${required}\n` +
    `passed=${passed}`
  );
  if (passed) return { passed: true, required };
  return { passed: false, required, reason: `Confidence ${Number.isFinite(conf) ? conf : '?'}% < auto-execution floor ${required}%.` };
}

export function checkMargin({ marginAvailable, estimatedMargin } = {}) {
  const avail = Number(marginAvailable);
  const req = Number(estimatedMargin);
  if (!Number.isFinite(avail) || !Number.isFinite(req) || req < 0) {
    return { passed: false, allowed: false, reason: MARGIN_RESTRICTION_MESSAGE };
  }
  if (req > avail + 1e-9) {
    return { passed: false, allowed: false, reason: MARGIN_RESTRICTION_MESSAGE };
  }
  return { passed: true, allowed: true };
}

export function getRiskStatus({ accountId, balanceUSD, now = new Date() } = {}) {
  const cfg = riskConfig();
  const lock = checkDailyRiskLock({ accountId, balanceUSD, now }, cfg);
  const balance = Number(balanceUSD);
  return {
    accountBalance: Number.isFinite(balance) ? +balance.toFixed(2) : null,
    riskPerTradePercent: cfg.maxRiskPerTradePercent,
    riskAmountUSD: computeRiskBudgetUSD(balance, cfg),
    nextTradeRiskPercent: lock.nextTradeRiskPercent,
    postLossRiskPercent: cfg.postLossRiskPercent,
    recoveryTradesRemaining: lock.recoveryTradesRemaining,
    dailyStartingBalance: lock.startingBalance,
    dailyRealizedPnL: lock.realizedPnL,
    dailyLossLimitPercent: cfg.dailyMaxDrawdownPercent,
    dailyLossLimitUSD: lock.lossLimit,
    remainingLossBudgetUSD: lock.remainingLossBudget,
    tradingLocked: lock.tradingLocked,
    autoExecutionConfidenceThreshold: cfg.autoExecutionMinConfidence,
  };
}
