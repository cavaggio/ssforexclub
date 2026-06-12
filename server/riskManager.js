/**
 * server/riskManager.js
 *
 * CENTRAL risk-management layer. Every automated execution engine (V3, V3.5,
 * ICT, Auto AI, and any future engine) routes its pre-trade risk decisions
 * through this single module so a change here applies platform-wide — no
 * per-engine duplication (hardening requirement #6).
 *
 * Controls owned here:
 *   1. Dynamic risk per trade — HARD cap at RISK_MAX_PER_TRADE_PERCENT (1.4%).
 *      No confidence/quality score may override it.
 *   2. Daily max-drawdown circuit breaker — RISK_DAILY_MAX_DRAWDOWN_PERCENT
 *      (2.8%) of the day's starting balance. When hit, new entries are locked
 *      (open-position management is unaffected). Resets at New York midnight.
 *   3. Auto-execution confidence floor — RISK_AUTO_EXECUTION_MIN_CONFIDENCE (90).
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
    maxRiskPerTradePercent: parseFloat(process.env.RISK_MAX_PER_TRADE_PERCENT || '1.4'),
    dailyMaxDrawdownPercent: parseFloat(process.env.RISK_DAILY_MAX_DRAWDOWN_PERCENT || '2.8'),
    autoExecutionMinConfidence: parseFloat(process.env.RISK_AUTO_EXECUTION_MIN_CONFIDENCE || '90'),
    // Progressive tightening: once realized daily loss reaches this % of the
    // day's starting balance, the account enters conservative mode and the
    // auto-execution confidence floor rises to conservativeMinConfidence.
    conservativeTriggerPercent: parseFloat(process.env.RISK_CONSERVATIVE_TRIGGER_PERCENT || '1.4'),
    conservativeMinConfidence: parseFloat(process.env.RISK_CONSERVATIVE_MIN_CONFIDENCE || '95'),
    // Optional absolute stop-loss-distance ceiling (pips). 0 = disabled; the
    // binding "too wide" guard is always the per-trade risk budget (a stop so
    // wide it can't size ≥1 unit at the cap is rejected).
    maxStopLossPips: parseFloat(process.env.RISK_MAX_STOP_LOSS_PIPS || '0'),
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

/**
 * Reduce a proposed position to fit within the per-trade risk budget, or reject.
 *
 *   riskBudgetUSD = balance × maxRiskPerTradePercent
 *   maxUnits      = floor(riskBudgetUSD / riskPerUnitUSD)
 *
 * `riskPerUnitUSD` = stop-loss distance (pips) × USD-per-pip-per-unit — i.e. the
 * dollar loss of ONE unit if the stop is hit. Returns the largest unit count
 * that risks ≤ the cap. Rejects (ok:false) when the stop can't be priced or even
 * a single unit would exceed the cap — never loosens the rule to fill the trade.
 */
export function clampUnitsToRiskBudget({ balanceUSD, requestedUnits, riskPerUnitUSD }, cfg = riskConfig()) {
  const balance = Number(balanceUSD);
  const reqUnits = Math.abs(Number(requestedUnits));
  const perUnit = Number(riskPerUnitUSD);
  const riskBudgetUSD = computeRiskBudgetUSD(balance, cfg);

  if (!Number.isFinite(balance) || balance <= 0) {
    return { ok: false, reason: 'Cannot size trade — account balance is unavailable.' };
  }
  if (!Number.isFinite(perUnit) || perUnit <= 0) {
    return { ok: false, reason: 'Cannot price stop-loss risk per unit — trade rejected.' };
  }
  if (!Number.isFinite(reqUnits) || reqUnits < 1) {
    return { ok: false, reason: 'Requested position is below the minimum tradable size.' };
  }

  const maxUnits = Math.floor(riskBudgetUSD / perUnit);
  if (maxUnits < 1) {
    return {
      ok: false,
      maxUnits,
      riskBudgetUSD,
      reason: `Stop-loss too wide to size within ${cfg.maxRiskPerTradePercent}% risk ` +
        `($${riskBudgetUSD.toFixed(2)}) — one unit risks $${perUnit.toFixed(2)}. Trade rejected.`,
    };
  }

  const units = Math.min(reqUnits, maxUnits);
  const reduced = units < reqUnits;
  const riskUSD = +(units * perUnit).toFixed(2);
  return { ok: true, units, reduced, maxUnits, riskUSD, riskBudgetUSD, requestedUnits: reqUnits };
}

/**
 * Pre-execution stop-loss validation. A trade with a missing, invalid (wrong
 * side of entry), zero/negative, too-wide, or unpriceable stop is rejected —
 * a trade must never be submitted without an enforceable ≤cap loss boundary.
 */
export function validateStopLoss({ entry, stopLoss, direction, stopLossPips, riskPerUnitUSD = null }, cfg = riskConfig()) {
  const e = Number(entry);
  const sl = Number(stopLoss);
  const pips = Number(stopLossPips);
  if (!Number.isFinite(sl)) return { valid: false, reason: 'Stop loss is missing or not a number — trade rejected.' };
  if (!Number.isFinite(e)) return { valid: false, reason: 'Entry price is missing or not a number — trade rejected.' };
  const dir = String(direction || '').toLowerCase();
  const isLong = dir === 'long' || dir === 'buy';
  const isShort = dir === 'short' || dir === 'sell';
  if (!isLong && !isShort) return { valid: false, reason: `Invalid direction "${direction}" — trade rejected.` };
  if (isLong && !(sl < e)) return { valid: false, reason: 'Invalid stop loss for long (must be below entry) — trade rejected.' };
  if (isShort && !(sl > e)) return { valid: false, reason: 'Invalid stop loss for short (must be above entry) — trade rejected.' };
  if (!Number.isFinite(pips) || pips <= 0) return { valid: false, reason: 'Stop-loss distance is zero/invalid — trade rejected.' };
  if (cfg.maxStopLossPips > 0 && pips > cfg.maxStopLossPips) {
    return { valid: false, reason: `Stop loss too wide (${pips}p > ${cfg.maxStopLossPips}p cap) — trade rejected.` };
  }
  if (riskPerUnitUSD != null && (!Number.isFinite(Number(riskPerUnitUSD)) || Number(riskPerUnitUSD) <= 0)) {
    return { valid: false, reason: 'Cannot price stop-loss risk — trade rejected.' };
  }
  return { valid: true };
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
  // Loss limit and conservative trigger are anchored to the day's STARTING
  // balance — fixed for the whole day. They never move with the current balance.
  const lossLimit = +(startingBalance * (cfg.dailyMaxDrawdownPercent / 100)).toFixed(2);
  const conservativeTrigger = +(startingBalance * (cfg.conservativeTriggerPercent / 100)).toFixed(2);
  // balance reflects realized P&L; positive = profit, negative = loss for the day.
  const realizedPnL = +(balance - startingBalance).toFixed(2);
  const tradingLocked = lossLimit > 0 && realizedPnL <= -lossLimit;
  // Progressive tightening: conservative mode kicks in once realized loss reaches
  // the trigger (default 1.4%) — the auto-execution confidence floor rises to 95.
  const conservativeMode = conservativeTrigger > 0 && realizedPnL <= -conservativeTrigger;
  const activeConfidenceThreshold = conservativeMode ? cfg.conservativeMinConfidence : cfg.autoExecutionMinConfidence;
  const remainingLossBudget = +Math.max(0, lossLimit + realizedPnL).toFixed(2);
  console.log(
    `[DAILY RISK LOCK]\n` +
    `startingBalance=${startingBalance.toFixed(2)}\n` +
    `realizedPnL=${realizedPnL.toFixed(2)}\n` +
    `lossLimit=${lossLimit.toFixed(2)}\n` +
    `conservativeMode=${conservativeMode}\n` +
    `activeConfidenceThreshold=${activeConfidenceThreshold}\n` +
    `tradingLocked=${tradingLocked}`
  );
  return {
    tradingLocked,
    startingBalance,
    realizedPnL,
    lossLimit,
    conservativeTrigger,
    conservativeMode,
    activeConfidenceThreshold,
    remainingLossBudget,
    dailyMaxDrawdownPercent: cfg.dailyMaxDrawdownPercent,
    reason: tradingLocked
      ? `Daily drawdown limit reached: realized P&L $${realizedPnL.toFixed(2)} ` +
        `breached -$${lossLimit.toFixed(2)} (${cfg.dailyMaxDrawdownPercent}% of $${startingBalance.toFixed(2)}). ` +
        `New entries are locked until NY-midnight reset; open trades keep being managed.`
      : null,
  };
}

// ─── Last-rejection store (per account) — surfaced on the dashboard ──────────
const lastRejection = new Map();

/** Record the most recent risk rejection for an account (for the dashboard). */
export function recordRejection({ accountId, reason, engine = null, now = new Date() } = {}) {
  if (!reason) return;
  lastRejection.set(accountKey(accountId), { reason, engine, at: now.toISOString() });
}

/** Read the most recent risk rejection for an account, or null. */
export function getLastRejection(accountId) {
  return lastRejection.get(accountKey(accountId)) || null;
}

/** Manual/admin reset of all daily baselines (e.g. broker daily reset hook). */
export function resetDailyRisk() {
  const cleared = dailyState.size;
  dailyState.clear();
  console.log(`[DAILY RISK LOCK] reset — cleared ${cleared} account baseline(s)`);
  return { ok: true, cleared };
}

// ─── Durable persistence — survives server/Railway restarts ─────────────────
// The in-memory `dailyState` Map is a per-process cache; the injected store is
// the durable backing (Supabase). Without a store, behaviour is unchanged
// (in-memory only). Injected at server startup via setRiskStore().
let _store = null;

/** Inject the durable store ({ load, upsert }) or null for in-memory only. */
export function setRiskStore(store) { _store = store; }

/**
 * Seed this process's in-memory baseline for an account from durable storage
 * when it doesn't already hold today's baseline (cache miss / fresh restart).
 * This is what stops a mid-day restart from re-anchoring the day's starting
 * balance to the current (lower) balance. Best-effort: on any store error it
 * logs and lets the in-memory path create a fresh baseline.
 *
 * MUST be awaited before the first daily-state check of a request so the sync
 * checks (checkDailyRiskLock / checkAutoExecutionConfidence) read the durable
 * baseline rather than minting a new one.
 */
export async function hydrateDailyBaseline({ accountId, balanceUSD, now = new Date() } = {}) {
  void balanceUSD; // current balance is intentionally NOT used to seed — never re-anchor.
  if (!_store) return { hydrated: false, reason: 'no_store' };
  const key = accountKey(accountId);
  const dayKey = nyDateKey(now);
  const cached = dailyState.get(key);
  if (cached && cached.dayKey === dayKey && Number.isFinite(cached.startingBalance) && cached.startingBalance > 0) {
    return { hydrated: false, reason: 'cache_fresh' };
  }
  try {
    const row = await _store.load({ accountId, tradingDateKey: dayKey });
    const startingBalance = Number(row?.startingBalance);
    if (Number.isFinite(startingBalance) && startingBalance > 0) {
      dailyState.set(key, { dayKey, startingBalance });
      console.log(`[DAILY RISK LOCK] hydrated baseline ${key} (${dayKey}) startingBalance=${startingBalance.toFixed(2)}`);
      return { hydrated: true, startingBalance };
    }
    return { hydrated: false, reason: 'no_row_today' };
  } catch (err) {
    console.warn(`[DAILY RISK LOCK] hydrate failed ${key}: ${err?.message || err} — using in-memory baseline.`);
    return { hydrated: false, error: String(err?.message || err) };
  }
}

/**
 * Persist the current daily risk snapshot (the object returned by
 * checkDailyRiskLock) for an account. Best-effort: store errors are logged,
 * never thrown — a DB hiccup must never block or unblock trading.
 */
export async function persistDailyState({ accountId, status, now = new Date() } = {}) {
  if (!_store || !status) return { persisted: false };
  try {
    await _store.upsert({
      accountId,
      tradingDateKey: nyDateKey(now),
      startingBalance: status.startingBalance,
      realizedDailyPnL: status.realizedPnL,
      dailyLossLimit: status.lossLimit,
      conservativeMode: status.conservativeMode,
      tradingLocked: status.tradingLocked,
      lastUpdatedAt: now.toISOString(),
    });
    return { persisted: true };
  } catch (err) {
    console.warn(`[DAILY RISK LOCK] persist failed ${accountKey(accountId)}: ${err?.message || err}`);
    return { persisted: false, error: String(err?.message || err) };
  }
}

// ─── 3. Auto-execution confidence floor (progressive tightening) ────────────

/**
 * The active confidence floor for an account: the base floor (90), or the
 * conservative floor (95) once the account is in conservative mode. Reads the
 * per-account daily state without logging. Falls back to the base floor when no
 * account context is supplied.
 */
export function resolveActiveConfidenceThreshold({ accountId = null, balanceUSD = null, now = new Date() } = {}, cfg = riskConfig()) {
  if (accountId == null && balanceUSD == null) {
    return { threshold: cfg.autoExecutionMinConfidence, conservativeMode: false };
  }
  const state = ensureDailyBaseline({ accountId, balanceUSD, now });
  const startingBalance = Number(state.startingBalance) || 0;
  const balance = Number.isFinite(Number(balanceUSD)) ? Number(balanceUSD) : startingBalance;
  const realizedPnL = +(balance - startingBalance).toFixed(2);
  const conservativeTrigger = +(startingBalance * (cfg.conservativeTriggerPercent / 100)).toFixed(2);
  const conservativeMode = conservativeTrigger > 0 && realizedPnL <= -conservativeTrigger;
  return {
    threshold: conservativeMode ? cfg.conservativeMinConfidence : cfg.autoExecutionMinConfidence,
    conservativeMode,
  };
}

/**
 * Auto execution requires confidence ≥ the ACTIVE floor (90 normally, 95 in
 * conservative mode). Pass { accountId, balanceUSD } to apply progressive
 * tightening; without it the base floor is used. Logs [AUTO EXECUTION FILTER].
 */
export function checkAutoExecutionConfidence(confidence, ctx = {}, cfg = riskConfig()) {
  const { threshold: required, conservativeMode } = resolveActiveConfidenceThreshold(ctx, cfg);
  const conf = Number(confidence);
  const passed = Number.isFinite(conf) && conf >= required;
  console.log(
    `[AUTO EXECUTION FILTER]\n` +
    `confidence=${Number.isFinite(conf) ? conf : 'n/a'}\n` +
    `required=${required}\n` +
    `conservativeMode=${conservativeMode}\n` +
    `passed=${passed}`
  );
  if (passed) return { passed: true, required, conservativeMode };
  return {
    passed: false,
    required,
    conservativeMode,
    reason: `Confidence ${Number.isFinite(conf) ? conf : '?'}% < ` +
      `${conservativeMode ? 'conservative-mode ' : ''}auto-execution floor ${required}%.`,
  };
}

// ─── Conservative-mode correlated-exposure guard ────────────────────────────

function pairLegs(pair) {
  const norm = String(pair || '').replace('/', '_').toUpperCase().split('_');
  return norm.length === 2 ? { base: norm[0], quote: norm[1] } : null;
}
function directionSign(d) {
  const s = String(d || '').toLowerCase();
  if (s === 'long' || s === 'buy') return 1;
  if (s === 'short' || s === 'sell') return -1;
  return 0;
}

/**
 * In conservative mode, refuse a NEW trade that increases existing directional
 * exposure — i.e. an open position that shares a currency leg pulling the same
 * way (e.g. long EUR_USD while already long EUR_GBP both add EUR-long risk).
 * Outside conservative mode this is a no-op (returns allowed).
 */
export function checkConservativeCorrelatedExposure({ conservativeMode, pair, direction, openTrades = [] } = {}) {
  if (!conservativeMode) return { allowed: true };
  const legs = pairLegs(pair);
  const sign = directionSign(direction);
  if (!legs || sign === 0) return { allowed: true };
  // New trade's per-currency exposure: +base, -quote (scaled by direction).
  const want = { [legs.base]: sign, [legs.quote]: -sign };
  for (const t of Array.isArray(openTrades) ? openTrades : []) {
    const ol = pairLegs(t?.instrument ?? t?.pair);
    const os = directionSign(t?.direction ?? (Number(t?.currentUnits) > 0 ? 'long' : Number(t?.currentUnits) < 0 ? 'short' : null));
    if (!ol || os === 0) continue;
    const open = { [ol.base]: os, [ol.quote]: -os };
    for (const ccy of Object.keys(want)) {
      if (open[ccy] && Math.sign(open[ccy]) === Math.sign(want[ccy])) {
        return {
          allowed: false,
          reason: `Conservative mode: new ${direction} ${pair} reinforces existing ${ccy} exposure ` +
            `(open ${ol.base}_${ol.quote}) — refusing to increase correlated directional risk.`,
        };
      }
    }
  }
  return { allowed: true };
}

/**
 * Structured pre-submit risk log — emitted by every engine immediately before
 * the order is sent so the exact sizing inputs are auditable.
 */
export function logPreSubmit({ engine, mode, balanceUSD, stopLossPips, units, actualDollarRisk, riskPercent = null }) {
  console.log(
    `[PRE-SUBMIT RISK]\n` +
    `engine=${engine}\n` +
    `mode=${mode}\n` +
    `balance=${Number.isFinite(Number(balanceUSD)) ? Number(balanceUSD).toFixed(2) : 'n/a'}\n` +
    `stopLossPips=${stopLossPips ?? 'n/a'}\n` +
    `units=${units ?? 'n/a'}\n` +
    `actualDollarRisk=${Number.isFinite(Number(actualDollarRisk)) ? Number(actualDollarRisk).toFixed(2) : 'n/a'}\n` +
    `riskPercent=${riskPercent != null ? `${riskPercent}%` : 'n/a'}`
  );
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
  const last = getLastRejection(accountId);
  return {
    accountBalance: Number.isFinite(balance) ? +balance.toFixed(2) : null,
    currentBalance: Number.isFinite(balance) ? +balance.toFixed(2) : null,
    riskPerTradePercent: cfg.maxRiskPerTradePercent,
    riskAmountUSD: computeRiskBudgetUSD(balance, cfg),
    dailyStartingBalance: lock.startingBalance,
    dailyRealizedPnL: lock.realizedPnL,
    dailyLossLimitPercent: cfg.dailyMaxDrawdownPercent,
    dailyLossLimitUSD: lock.lossLimit,
    remainingLossBudgetUSD: lock.remainingLossBudget,
    tradingLocked: lock.tradingLocked,
    conservativeMode: lock.conservativeMode,
    autoExecutionConfidenceThreshold: cfg.autoExecutionMinConfidence,
    currentAutoConfidenceThreshold: lock.activeConfidenceThreshold,
    lastRejectedReason: last?.reason ?? null,
    lastRejectedAt: last?.at ?? null,
  };
}
