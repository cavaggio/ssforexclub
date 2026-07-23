import { createClient } from '@supabase/supabase-js';

/**
 * server/riskManager.js
 *
 * Central risk policy for every automated forex engine.
 *
 * Controls:
 *   1. Maximum risk per trade: 1% of current balance.
 *   2. Daily realized-loss lock: 2% of the New York day's starting balance.
 *   3. The first filled trade after a realized loss is reduced to 0.5% risk.
 *   4. Daily state is persisted so Railway restarts cannot clear the lock or
 *      pending recovery-trade sizing.
 *   5. Auto-execution confidence and margin guards remain centralized here.
 */

export const MARGIN_RESTRICTION_MESSAGE = 'Account margin restriction would be exceeded.';
const RISK_TOLERANCE = 0.005;
const BALANCE_TOLERANCE_USD = 0.01;
const DAILY_RISK_TABLE = 'forex_daily_risk_state';

function boundedPositive(value, fallback, maximum) {
  const parsed = Number(value);
  const safe = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.min(maximum, safe);
}

function asDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
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
//   dayKey, startingBalance, lastObservedBalance, recoveryTradesRemaining,
//   lastLossDetectedAt, tradingLocked
// }
const dailyState = new Map();
const hydrationPromises = new Map();
let supabaseClient;
let persistenceOverride = null;

function nyDateKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(asDate(now));
}

function accountKey(accountId) {
  return accountId ? String(accountId) : '__default__';
}

function persistenceClient() {
  if (persistenceOverride) return persistenceOverride;
  if (supabaseClient !== undefined) return supabaseClient;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  supabaseClient = url && key
    ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;
  return supabaseClient;
}

function stateFromRow(row, fallbackBalance = 0) {
  const startingBalance = Number(row?.starting_balance ?? fallbackBalance) || 0;
  return {
    dayKey: String(row?.risk_date || ''),
    startingBalance,
    lastObservedBalance: Number(row?.last_observed_balance ?? startingBalance) || startingBalance,
    recoveryTradesRemaining: Math.max(0, Number(row?.recovery_trades_remaining) || 0),
    lastLossDetectedAt: row?.last_loss_detected_at || null,
    tradingLocked: row?.trading_locked === true,
  };
}

function rowFromState(accountId, state) {
  const startingBalance = Number(state.startingBalance) || 0;
  const lastObservedBalance = Number(state.lastObservedBalance) || startingBalance;
  return {
    account_id: accountKey(accountId),
    risk_date: state.dayKey,
    starting_balance: startingBalance,
    last_observed_balance: lastObservedBalance,
    realized_pnl: +(lastObservedBalance - startingBalance).toFixed(2),
    recovery_trades_remaining: Math.max(0, Number(state.recoveryTradesRemaining) || 0),
    last_loss_detected_at: state.lastLossDetectedAt || null,
    trading_locked: state.tradingLocked === true,
  };
}

async function loadPersistedState(accountId, dayKey) {
  const persistence = persistenceClient();
  if (!persistence) return null;
  if (typeof persistence.load === 'function') {
    return persistence.load(accountKey(accountId), dayKey);
  }
  const { data, error } = await persistence
    .from(DAILY_RISK_TABLE)
    .select('*')
    .eq('account_id', accountKey(accountId))
    .eq('risk_date', dayKey)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function savePersistedState(accountId, state) {
  const persistence = persistenceClient();
  if (!persistence) return { persisted: false, storage: 'memory' };
  const row = rowFromState(accountId, state);
  if (typeof persistence.save === 'function') {
    await persistence.save(row);
    return { persisted: true, storage: 'test-adapter' };
  }
  const { error } = await persistence
    .from(DAILY_RISK_TABLE)
    .upsert(row, { onConflict: 'account_id,risk_date' });
  if (error) throw error;
  return { persisted: true, storage: 'supabase' };
}

async function deletePersistedState(accountId, dayKey = null) {
  const persistence = persistenceClient();
  if (!persistence) return { persisted: false, storage: 'memory' };
  if (typeof persistence.clear === 'function') {
    await persistence.clear(accountId == null ? null : accountKey(accountId), dayKey);
    return { persisted: true, storage: 'test-adapter' };
  }
  let query = persistence.from(DAILY_RISK_TABLE).delete();
  if (accountId != null) query = query.eq('account_id', accountKey(accountId));
  if (dayKey) query = query.eq('risk_date', dayKey);
  const { error } = await query;
  if (error) throw error;
  return { persisted: true, storage: 'supabase' };
}

function observeRealizedBalance(state, balance, now = new Date()) {
  if (!Number.isFinite(balance)) return state;
  const previous = Number(state.lastObservedBalance);
  if (Number.isFinite(previous) && balance < previous - BALANCE_TOLERANCE_USD) {
    state.recoveryTradesRemaining = 1;
    state.lastLossDetectedAt = asDate(now).toISOString();
    console.log(
      `[POST_LOSS_RISK] realized balance decreased ${previous.toFixed(2)} → ${balance.toFixed(2)}; ` +
      'next filled trade will use 0.5% risk',
    );
  }
  state.lastObservedBalance = balance;
  return state;
}

function applyDailyLockLatch(state, balanceUSD, cfg = riskConfig()) {
  const startingBalance = Number(state.startingBalance) || 0;
  const balance = Number.isFinite(Number(balanceUSD)) ? Number(balanceUSD) : Number(state.lastObservedBalance) || startingBalance;
  const lossLimit = +(startingBalance * (cfg.dailyMaxDrawdownPercent / 100)).toFixed(2);
  const realizedPnL = +(balance - startingBalance).toFixed(2);
  if (lossLimit > 0 && realizedPnL <= -lossLimit) state.tradingLocked = true;
  return { startingBalance, balance, lossLimit, realizedPnL, tradingLocked: state.tradingLocked === true };
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
      tradingLocked: false,
    };
    dailyState.set(key, next);
    return next;
  }
  if ((!Number.isFinite(prev.startingBalance) || prev.startingBalance <= 0) && Number.isFinite(balance)) {
    prev.startingBalance = balance;
  }
  observeRealizedBalance(prev, balance, now);
  return prev;
}

/**
 * Load today's durable state before any risk decision. Database errors degrade to
 * the in-process state and are logged; they never bypass the in-memory risk checks.
 */
export async function hydrateDailyRiskState({ accountId, balanceUSD, now = new Date() } = {}) {
  const key = accountKey(accountId);
  const dayKey = nyDateKey(now);
  const existing = dailyState.get(key);
  if (existing?.dayKey === dayKey) {
    observeRealizedBalance(existing, Number(balanceUSD), now);
    applyDailyLockLatch(existing, balanceUSD);
    return existing;
  }

  const hydrationKey = `${key}:${dayKey}`;
  if (hydrationPromises.has(hydrationKey)) return hydrationPromises.get(hydrationKey);

  const promise = (async () => {
    let state;
    try {
      const row = await loadPersistedState(key, dayKey);
      if (row) {
        state = stateFromRow(row, Number(balanceUSD));
        state.dayKey = dayKey;
        dailyState.set(key, state);
        observeRealizedBalance(state, Number(balanceUSD), now);
        applyDailyLockLatch(state, balanceUSD);
      }
    } catch (error) {
      console.warn(`[DAILY RISK PERSISTENCE] hydrate failed account=${key}: ${error?.message || error}`);
    }

    if (!state) {
      state = ensureDailyBaseline({ accountId: key, balanceUSD, now });
      applyDailyLockLatch(state, balanceUSD);
    }

    try {
      await savePersistedState(key, state);
    } catch (error) {
      console.warn(`[DAILY RISK PERSISTENCE] initial save failed account=${key}: ${error?.message || error}`);
    }
    return state;
  })().finally(() => hydrationPromises.delete(hydrationKey));

  hydrationPromises.set(hydrationKey, promise);
  return promise;
}

export async function persistDailyRiskState({ accountId, balanceUSD, now = new Date() } = {}) {
  const state = ensureDailyBaseline({ accountId, balanceUSD, now });
  applyDailyLockLatch(state, balanceUSD);
  try {
    return await savePersistedState(accountId, state);
  } catch (error) {
    console.warn(`[DAILY RISK PERSISTENCE] save failed account=${accountKey(accountId)}: ${error?.message || error}`);
    return { persisted: false, storage: 'memory', error: error?.message || String(error) };
  }
}

export function recordRealizedTradeResult({ accountId, realizedPnL, balanceUSD, now = new Date() } = {}) {
  const state = ensureDailyBaseline({ accountId, balanceUSD, now });
  const pnl = Number(realizedPnL);
  if (Number.isFinite(pnl) && pnl < 0) {
    state.recoveryTradesRemaining = 1;
    state.lastLossDetectedAt = asDate(now).toISOString();
  }
  if (Number.isFinite(Number(balanceUSD))) state.lastObservedBalance = Number(balanceUSD);
  applyDailyLockLatch(state, balanceUSD);
  return {
    recoveryTradesRemaining: state.recoveryTradesRemaining,
    nextTradeRiskPercent: state.recoveryTradesRemaining > 0 ? riskConfig().postLossRiskPercent : riskConfig().maxRiskPerTradePercent,
    tradingLocked: state.tradingLocked === true,
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
  const lock = applyDailyLockLatch(state, balanceUSD, cfg);
  const remainingLossBudget = lock.tradingLocked
    ? 0
    : +Math.max(0, lock.lossLimit + lock.realizedPnL).toFixed(2);
  console.log(
    `[DAILY RISK LOCK]\n` +
    `startingBalance=${lock.startingBalance.toFixed(2)}\n` +
    `realizedPnL=${lock.realizedPnL.toFixed(2)}\n` +
    `lossLimit=${lock.lossLimit.toFixed(2)}\n` +
    `tradingLocked=${lock.tradingLocked}`
  );
  return {
    tradingLocked: lock.tradingLocked,
    startingBalance: lock.startingBalance,
    realizedPnL: lock.realizedPnL,
    lossLimit: lock.lossLimit,
    remainingLossBudget,
    dailyMaxDrawdownPercent: cfg.dailyMaxDrawdownPercent,
    recoveryTradesRemaining: state.recoveryTradesRemaining,
    nextTradeRiskPercent: state.recoveryTradesRemaining > 0 ? cfg.postLossRiskPercent : cfg.maxRiskPerTradePercent,
    reason: lock.tradingLocked
      ? `Daily drawdown limit reached: the account hit the ${cfg.dailyMaxDrawdownPercent}% daily loss limit ` +
        `(-$${lock.lossLimit.toFixed(2)} from the $${lock.startingBalance.toFixed(2)} New York-day baseline). ` +
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

export function resetDailyRisk(accountId = null) {
  if (accountId != null) {
    const key = accountKey(accountId);
    const cleared = dailyState.delete(key) ? 1 : 0;
    console.log(`[DAILY RISK LOCK] account reset accountId=${key} cleared=${cleared}`);
    return { ok: true, cleared, accountId: key, scope: 'account' };
  }
  const cleared = dailyState.size;
  dailyState.clear();
  console.log(`[DAILY RISK LOCK] global reset — cleared ${cleared} account baseline(s)`);
  return { ok: true, cleared, accountId: null, scope: 'all' };
}

export async function resetPersistedDailyRisk({ accountId = null, now = new Date(), allDates = false } = {}) {
  resetDailyRisk(accountId);
  try {
    return await deletePersistedState(accountId, allDates ? null : nyDateKey(now));
  } catch (error) {
    console.warn(`[DAILY RISK PERSISTENCE] reset failed account=${accountId ?? 'ALL'}: ${error?.message || error}`);
    return { persisted: false, error: error?.message || String(error) };
  }
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

export function __setRiskPersistenceForTests(adapter = null) {
  persistenceOverride = adapter;
  supabaseClient = undefined;
}

export function __resetRiskMemoryForTests() {
  dailyState.clear();
  hydrationPromises.clear();
}
