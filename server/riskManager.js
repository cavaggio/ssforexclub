/**
 * server/riskManager.js
 *
 * CENTRAL risk-management layer. Every automated execution engine (V3, V3.5,
 * ICT, Auto AI, and any future engine) routes its pre-trade risk decisions
 * through this single module so a change here applies platform-wide — no
 * per-engine duplication (hardening requirement #6).
 *
 * Controls owned here:
 *   1. Dynamic risk per trade — HARD cap at RISK_MAX_PER_TRADE_PERCENT (1.25%).
 *      No confidence/quality score may override it.
 *   2. Daily max-drawdown circuit breaker — RISK_DAILY_MAX_DRAWDOWN_PERCENT
 *      (2.5%) of the day's starting balance. When hit, new entries are locked
 *      (open-position management is unaffected). Resets at New York midnight.
 *   3. Auto-execution confidence floor — RISK_AUTO_EXECUTION_MIN_CONFIDENCE (85).
 *   4. Margin availability — never submit an order whose required margin exceeds
 *      available margin (never bypasses the broker's own restriction).
 *
 * Daily state is keyed by accountId so one user hitting their drawdown limit
 * never locks another user (the process is multi-tenant).
 *
 * Realized daily P&L is derived from the broker `balance`, which moves only on
 * realized closes/financing — so we don't need to hook every close event:
 *   dailyRealizedPnL ≈ currentBalance − dailyStartingBalance
 */

// Exact operator-facing message required when a margin restriction would be hit.
export const MARGIN_RESTRICTION_MESSAGE = 'Account margin restriction would be exceeded.';

// Small relative tolerance so integer-unit / pip rounding in sizing doesn't
// trip the hard risk cap by a fraction of a cent.
const RISK_TOLERANCE = 0.005; // 0.5%

export function riskConfig() {
  return {
    maxRiskPerTradePercent: parseFloat(process.env.RISK_MAX_PER_TRADE_PERCENT || '1.25'),
    dailyMaxDrawdownPercent: 2.5,
    autoExecutionMinConfidence: Math.max(85, parseFloat(process.env.RISK_AUTO_EXECUTION_MIN_CONFIDENCE || process.env.FOREX_MIN_CONFIDENCE || '85')),
  };
}

// ─── 1. Dynamic risk per trade ──────────────────────────────────────────────

/** Dollar risk budget for a trade = balance × maxRiskPerTradePercent. */
export function computeRiskBudgetUSD(balanceUSD, cfg = riskConfig()) {
  const balance = Number(balanceUSD);
  if (!Number.isFinite(balance) || balance <= 0) return 0;
  return +(balance * (cfg.maxRiskPerTradePercent / 100)).toFixed(2);
}

/** Clamp a requested per-trade risk percent down to the hard cap. */
export function capPerTradeRiskPercent(requestedRiskPercent, cfg = riskConfig()) {
  const max = cfg.maxRiskPerTradePercent;
  if (!Number.isFinite(requestedRiskPercent) || requestedRiskPercent <= 0) return max;
  return Math.min(requestedRiskPercent, max);
}

/**
 * Validate the ACTUAL dollar risk of a sized position against the hard cap.
 * Logs [RISK CHECK]. Returns { passed, reason, ... }.
 */
export function checkRiskPerTrade({ balanceUSD, actualDollarRisk, stopLossPips = null, positionSize = null }, cfg = riskConfig()) {
  const balance = Number(balanceUSD);
  const actual = Number(actualDollarRisk);
  const riskAmount = computeRiskBudgetUSD(balance, cfg);
  const ceiling = riskAmount * (1 + RISK_TOLERANCE);
  const passed = Number.isFinite(balance) && balance > 0 &&
    Number.isFinite(actual) && actual >= 0 && actual <= ceiling;
  const actualRiskPercent = (Number.isFinite(actual) && balance > 0) ? +((actual / balance) * 100).toFixed(4) : null;
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

// ─── 2. Daily max-drawdown circuit breaker ──────────────────────────────────

// accountId → { dayKey: 'YYYY-MM-DD' (NY), startingBalance: number }
const dailyState = new Map();

function nyDateKey(now = new Date()) {
  // en-CA yields YYYY-MM-DD; pin to America/New_York so the day rolls at NY midnight.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function accountKey(accountId) {
  return accountId ? String(accountId) : '__default__';
}

/**
 * Ensure today's baseline exists for the account; resets at NY-midnight rollover.
 * Returns the live state record.
 */
export function ensureDailyBaseline({ accountId, balanceUSD, now = new Date() }) {
  const key = accountKey(accountId);
  const dayKey = nyDateKey(now);
  const balance = Number(balanceUSD);
  const prev = dailyState.get(key);
  if (!prev || prev.dayKey !== dayKey) {
    const startingBalance = Number.isFinite(balance) ? balance : (prev?.startingBalance ?? 0);
    const next = { dayKey, startingBalance };
    dailyState.set(key, next);
    return next;
  }
  // Backfill the starting balance if the first observation of the day lacked one.
  if ((!Number.isFinite(prev.startingBalance) || prev.startingBalance <= 0) && Number.isFinite(balance)) {
    prev.startingBalance = balance;
  }
  return prev;
}

/**
 * Evaluate the daily drawdown lock for an account. Logs [DAILY RISK LOCK].
 * Returns a status object including tradingLocked.
 */
export function checkDailyRiskLock({ accountId, balanceUSD, now = new Date() }, cfg = riskConfig()) {
  const state = ensureDailyBaseline({ accountId, balanceUSD, now });
  const startingBalance = Number(state.startingBalance) || 0;
  const balance = Number.isFinite(Number(balanceUSD)) ? Number(balanceUSD) : startingBalance;
  const lossLimit = +(startingBalance * (cfg.dailyMaxDrawdownPercent / 100)).toFixed(2);
  // balance reflects realized P&L; positive = profit, negative = loss for the day.
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
    reason: tradingLocked
      ? `Daily drawdown limit reached: realized P&L $${realizedPnL.toFixed(2)} ` +
        `breached -$${lossLimit.toFixed(2)} (${cfg.dailyMaxDrawdownPercent}% of $${startingBalance.toFixed(2)}). ` +
        `New entries are locked until NY-midnight reset; open trades keep being managed.`
      : null,
  };
}

/** Size a new order to the uncommitted remainder of the fixed 2.5% daily budget. */
export function reserveDailyLossBudget({ accountId, balanceUSD, openRiskUSD = 0, requestedRiskUSD = 0, now = new Date() } = {}) {
  const lock = checkDailyRiskLock({ accountId, balanceUSD, now });
  const openRisk = Math.max(0, Number(openRiskUSD) || 0);
  const requested = Math.max(0, Number(requestedRiskUSD) || 0);
  const remainingAfterOpenRisk = Math.max(0, lock.remainingLossBudget - openRisk);
  const approvedRiskUSD = Math.floor(Math.min(requested, remainingAfterOpenRisk) * 100) / 100;
  return {
    allowed: !lock.tradingLocked && approvedRiskUSD > 0,
    capped: approvedRiskUSD + 0.005 < requested,
    approvedRiskUSD,
    requestedRiskUSD: requested,
    openRiskUSD: openRisk,
    remainingDailyBudgetUSD: lock.remainingLossBudget,
    remainingAfterOpenRiskUSD: remainingAfterOpenRisk,
    reason: lock.tradingLocked ? lock.reason : approvedRiskUSD <= 0 ? 'No uncommitted daily loss budget remains.' : null,
  };
}

/** Manual/admin reset of all daily baselines (e.g. broker daily reset hook). */
export function resetDailyRisk() {
  const cleared = dailyState.size;
  dailyState.clear();
  console.log(`[DAILY RISK LOCK] reset — cleared ${cleared} account baseline(s)`);
  return { ok: true, cleared };
}

// ─── 3. Auto-execution confidence floor ─────────────────────────────────────

/** Auto execution requires confidence ≥ floor. Logs [AUTO EXECUTION FILTER]. */
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

// ─── 4. Margin availability ─────────────────────────────────────────────────

/**
 * Margin guard. Blocks when required margin exceeds available margin (or either
 * figure is unusable). Additive to the broker's INSUFFICIENT_MARGIN rejection —
 * it refuses earlier, never bypasses a broker restriction.
 */
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

// ─── 5. Dashboard status ────────────────────────────────────────────────────

/** Read-only risk snapshot for the dashboard Risk Management panel. */
export function getRiskStatus({ accountId, balanceUSD, now = new Date() } = {}) {
  const cfg = riskConfig();
  const lock = checkDailyRiskLock({ accountId, balanceUSD, now }, cfg);
  const balance = Number(balanceUSD);
  return {
    accountBalance: Number.isFinite(balance) ? +balance.toFixed(2) : null,
    riskPerTradePercent: cfg.maxRiskPerTradePercent,
    riskAmountUSD: computeRiskBudgetUSD(balance, cfg),
    dailyStartingBalance: lock.startingBalance,
    dailyRealizedPnL: lock.realizedPnL,
    dailyLossLimitPercent: cfg.dailyMaxDrawdownPercent,
    dailyLossLimitUSD: lock.lossLimit,
    remainingLossBudgetUSD: lock.remainingLossBudget,
    tradingLocked: lock.tradingLocked,
    autoExecutionConfidenceThreshold: cfg.autoExecutionMinConfidence,
  };
}
