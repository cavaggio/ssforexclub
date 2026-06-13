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
  computeOpenRiskUSD,
  evaluateNewTradeBudget,
  getAccountRiskCycle,
  checkTpProbability,
  planDefensiveReduction,
  executeDefensiveReduction,
  MARGIN_RESTRICTION_MESSAGE,
} = await import('./riskManager.js');

const NOW = new Date('2026-06-10T15:00:00Z');

test('defaults are 1.4% per trade, 2.8% daily drawdown, 95 confidence, 2% profit target', () => {
  const cfg = riskConfig();
  assert.equal(cfg.maxRiskPerTradePercent, 1.4);
  assert.equal(cfg.dailyMaxDrawdownPercent, 2.8);
  assert.equal(cfg.autoExecutionMinConfidence, 95);
  assert.equal(cfg.dailyProfitTargetPercent, 2.0);
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

test('below the 1.4% trigger conservative mode is off (threshold stays 95)', () => {
  resetDailyRisk();
  checkDailyRiskLock({ accountId: 'ACC-STD', balanceUSD: 10000, now: NOW });
  const s = checkDailyRiskLock({ accountId: 'ACC-STD', balanceUSD: 9900, now: NOW }); // -1.0%
  assert.equal(s.conservativeMode, false);
  assert.equal(s.activeConfidenceThreshold, 95);
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

test('confidence at 95 passes the auto-execution floor', () => {
  assert.equal(checkAutoExecutionConfidence(95).passed, true);
});

test('confidence below 95 fails the auto-execution floor', () => {
  const r = checkAutoExecutionConfidence(94);
  assert.equal(r.passed, false);
  assert.match(r.reason, /floor 95%/);
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

// ── Account-as-one-risk-system: daily budget, open-risk projection ──────────

test('open trade risk = units × stop distance (counts before realizing loss)', () => {
  // 100k EUR_USD long, entry 1.10, stop 1.0972 → 28 pips → $280.
  const trades = [{ instrument: 'EUR_USD', currentUnits: '100000', price: '1.10', stopLossOrder: { price: '1.0972' } }];
  assert.equal(computeOpenRiskUSD(trades), 280);
});

test('new trade rejected when remaining daily loss budget is zero', () => {
  resetDailyRisk();
  // Starting 10k, down $280 (at the 2.8% limit) → remaining budget 0 → reject.
  evaluateNewTradeBudget({ accountId: 'BUD0', balanceUSD: 10000, now: NOW });
  // anchor baseline at 10k
  checkDailyRiskLock({ accountId: 'BUD0', balanceUSD: 10000, now: NOW });
  const r = evaluateNewTradeBudget({ accountId: 'BUD0', balanceUSD: 9720, openTradeRiskUSD: 0, now: NOW });
  assert.equal(r.allowedNewTradeRisk, 0);
  assert.equal(r.passed, false);
  assert.equal(r.shouldLock, true);
});

test('new trade size is reduced when remaining budget is below the 1.4% cap', () => {
  resetDailyRisk();
  // Starting 10k → 1.4% cap = $140, daily limit $280. Down $200 → remaining $80.
  checkDailyRiskLock({ accountId: 'BUD1', balanceUSD: 10000, now: NOW });
  const r = evaluateNewTradeBudget({ accountId: 'BUD1', balanceUSD: 9800, openTradeRiskUSD: 0, now: NOW });
  assert.equal(r.maxTradeRisk, 137.2);            // 1.4% of 9,800
  assert.equal(r.remainingDailyLossBudget, 80);   // 280 - 200
  assert.equal(r.allowedNewTradeRisk, 80);        // budget binds, below the 1.4% cap
});

test('open trade risk is included so projected risk cannot exceed 2.8%', () => {
  resetDailyRisk();
  // Starting 10k, flat realized, but $250 of open risk already → only $30 headroom.
  checkDailyRiskLock({ accountId: 'BUD2', balanceUSD: 10000, now: NOW });
  const r = evaluateNewTradeBudget({ accountId: 'BUD2', balanceUSD: 10000, openTradeRiskUSD: 250, now: NOW });
  assert.equal(r.allowedNewTradeRisk, 30);        // 280 cap - 250 open
  // A trade risking $40 would push projected risk over the cap → rejected.
  const over = evaluateNewTradeBudget({ accountId: 'BUD2', balanceUSD: 10000, openTradeRiskUSD: 250, newTradeRiskUSD: 40, now: NOW });
  assert.equal(over.passed, false);
  assert.ok(over.projectedDailyRisk > over.dailyLossLimit);
});

test('multiple trades are allowed while budget remains — risk, not a count, is the limiter', () => {
  resetDailyRisk();
  checkDailyRiskLock({ accountId: 'MULTI', balanceUSD: 10000, now: NOW }); // limit $280
  // Several small trades ($40 open risk each) keep passing — no trade-count cap.
  const a = evaluateNewTradeBudget({ accountId: 'MULTI', balanceUSD: 10000, openTradeRiskUSD: 0, newTradeRiskUSD: 40, now: NOW });
  const b = evaluateNewTradeBudget({ accountId: 'MULTI', balanceUSD: 10000, openTradeRiskUSD: 120, newTradeRiskUSD: 40, now: NOW });
  const c = evaluateNewTradeBudget({ accountId: 'MULTI', balanceUSD: 10000, openTradeRiskUSD: 240, newTradeRiskUSD: 40, now: NOW });
  assert.equal(a.passed, true);
  assert.equal(b.passed, true);
  // The 7th trade would push open+new to $280 = the cap → still allowed at the edge.
  assert.equal(c.passed, true);
  // But once open risk leaves < the new trade's room, risk (not count) stops it.
  const d = evaluateNewTradeBudget({ accountId: 'MULTI', balanceUSD: 10000, openTradeRiskUSD: 260, newTradeRiskUSD: 40, now: NOW });
  assert.equal(d.passed, false);
  assert.ok(d.projectedDailyRisk > d.dailyLossLimit);
});

test('getAccountRiskCycle flags capital-protection mode at +2% realized', () => {
  resetDailyRisk();
  checkDailyRiskLock({ accountId: 'CYC', balanceUSD: 10000, now: NOW });
  const c = getAccountRiskCycle({ accountId: 'CYC', balanceUSD: 10200, openTradeRiskUSD: 50, now: NOW });
  assert.equal(c.dailyProfitTarget, 200);
  assert.equal(c.profitTargetReached, true);
  assert.equal(c.capitalProtectionMode, true);
  assert.equal(c.openTradeRisk, 50);
});

// ── TP probability gate (rule 10) ───────────────────────────────────────────

test('TP gate rejects a target needing an unrealistic multiple of ATR', () => {
  const r = checkTpProbability({ stopLossPips: 20, takeProfitPips: 400, atrPips: 10 }); // 400 > 6×10
  assert.equal(r.passed, false);
  assert.match(r.reason, /unrealistic|ATR/i);
});

test('TP gate rejects when spread eats too much of the stop', () => {
  const r = checkTpProbability({ stopLossPips: 10, takeProfitPips: 30, spreadPips: 5 }); // 5 > 0.33×10
  assert.equal(r.passed, false);
});

test('TP gate passes a realistic target', () => {
  const r = checkTpProbability({ stopLossPips: 20, takeProfitPips: 60, atrPips: 25, spreadPips: 1.5 });
  assert.equal(r.passed, true);
  assert.equal(r.rr, 3);
});

// ── Defensive reduction plan (rule 5) ───────────────────────────────────────

test('planDefensiveReduction closes the worst trade first when the cap is threatened', () => {
  const openTrades = [
    { id: 'T1', instrument: 'EUR_USD', currentUnits: '100000', price: '1.10', stopLossOrder: { price: '1.0980' }, unrealizedPL: -30 }, // $200 risk
    { id: 'T2', instrument: 'GBP_USD', currentUnits: '100000', price: '1.25', stopLossOrder: { price: '1.2480' }, unrealizedPL: -5 },  // $200 risk
  ];
  // realized loss $0, two trades = $400 open risk, cap $280 → reduction needed.
  const plan = planDefensiveReduction({ openTrades, realizedPnL: 0, dailyLossLimit: 280 });
  assert.equal(plan.reductionNeeded, true);
  assert.equal(plan.toClose[0].tradeId, 'T1'); // worst unrealized PnL closed first
});

test('planDefensiveReduction is a no-op when projected risk is within the cap', () => {
  const openTrades = [{ id: 'T1', instrument: 'EUR_USD', currentUnits: '50000', price: '1.10', stopLossOrder: { price: '1.0980' }, unrealizedPL: 5 }];
  const plan = planDefensiveReduction({ openTrades, realizedPnL: 0, dailyLossLimit: 280 });
  assert.equal(plan.reductionNeeded, false);
});

test('executeDefensiveReduction closes the WORST trade first and stops once risk fits', async () => {
  // Three trades, $120 open risk each (100k × 12 pips) = $360 total > $280 cap.
  // Worst unrealized P&L is B; closing B alone ($360→$240) fits under the cap.
  const openTrades = [
    { id: 'A', instrument: 'EUR_USD', currentUnits: '100000', price: '1.10', stopLossOrder: { price: '1.0988' }, unrealizedPL: -5 },
    { id: 'B', instrument: 'GBP_USD', currentUnits: '100000', price: '1.25', stopLossOrder: { price: '1.2488' }, unrealizedPL: -50 },
    { id: 'C', instrument: 'AUD_USD', currentUnits: '100000', price: '0.66', stopLossOrder: { price: '0.6588' }, unrealizedPL: -20 },
  ];
  const closeOrder = [];
  const closeFn = async (t) => { closeOrder.push(t.tradeId); return { ok: true }; };
  const r = await executeDefensiveReduction({
    accountId: 'DEF', openTrades, realizedPnL: 0, dailyLossLimit: 280,
    autoDefensiveClose: true, closeFn,
  });
  assert.deepEqual(closeOrder, ['B']);          // worst-first, and only as many as needed
  assert.equal(r.closed.length, 1);
  assert.equal(r.closed[0].tradeId, 'B');
  assert.equal(r.closed[0].ok, true);
});

test('executeDefensiveReduction with the flag OFF recommends but does NOT close', async () => {
  const openTrades = [
    { id: 'A', instrument: 'EUR_USD', currentUnits: '100000', price: '1.10', stopLossOrder: { price: '1.0988' }, unrealizedPL: -5 },
    { id: 'B', instrument: 'GBP_USD', currentUnits: '100000', price: '1.25', stopLossOrder: { price: '1.2488' }, unrealizedPL: -50 },
    { id: 'C', instrument: 'AUD_USD', currentUnits: '100000', price: '0.66', stopLossOrder: { price: '0.6588' }, unrealizedPL: -20 },
  ];
  let calls = 0;
  const r = await executeDefensiveReduction({
    accountId: 'DEF2', openTrades, realizedPnL: 0, dailyLossLimit: 280,
    autoDefensiveClose: false, closeFn: async () => { calls += 1; return { ok: true }; },
  });
  assert.equal(calls, 0);                        // no broker close when flag is off
  assert.equal(r.plan.reductionNeeded, true);    // but the reduction is still planned
  assert.equal(r.closed.length, 0);
});

test('executeDefensiveReduction closes multiple worst-first when one is not enough', async () => {
  // Two trades $200 each = $400 > $280; closing one ($200) still leaves $200 ≤ 280,
  // so exactly one closes — confirm it picks the worst. Then a heavier case:
  const openTrades = [
    { id: 'X', instrument: 'EUR_USD', currentUnits: '100000', price: '1.10', stopLossOrder: { price: '1.0970' }, unrealizedPL: -10 }, // 30p → $300 risk
    { id: 'Y', instrument: 'GBP_USD', currentUnits: '100000', price: '1.25', stopLossOrder: { price: '1.2220' }, unrealizedPL: -80 }, // 280p → $2800 risk (worst)
  ];
  const order = [];
  await executeDefensiveReduction({
    accountId: 'DEF3', openTrades, realizedPnL: 0, dailyLossLimit: 280,
    autoDefensiveClose: true, closeFn: async (t) => { order.push(t.tradeId); return { ok: true }; },
  });
  assert.equal(order[0], 'Y'); // worst (most-negative unrealized) closed first
});

test('getRiskStatus surfaces the documented panel fields', () => {
  resetDailyRisk();
  const s = getRiskStatus({ accountId: 'ACC-S', balanceUSD: 10000, now: NOW });
  assert.equal(s.accountBalance, 10000);
  assert.equal(s.currentBalance, 10000);
  assert.equal(s.riskPerTradePercent, 1.4);
  assert.equal(s.riskAmountUSD, 140);
  assert.equal(s.dailyLossLimitPercent, 2.8);
  assert.equal(s.dailyLossLimitUSD, 280);
  assert.equal(s.autoExecutionConfidenceThreshold, 95);
  assert.equal(s.currentAutoConfidenceThreshold, 95);
  assert.equal(s.conservativeMode, false);
  assert.equal(s.capitalProtectionMode, false);
  assert.equal(s.tradingLocked, false);
  assert.equal(s.lastRejectedReason, null);
  // Account-level fields present.
  assert.equal(s.dailyProfitTargetUSD, 200); // 2% of 10k
  assert.equal(s.openTradeRiskUSD, 0);
  assert.equal(s.projectedDailyRiskUSD, 0);
});

test('getRiskStatus reflects conservative mode + the active 95% threshold', () => {
  resetDailyRisk();
  getRiskStatus({ accountId: 'ACC-S2', balanceUSD: 10000, now: NOW });        // baseline 10k
  const s = getRiskStatus({ accountId: 'ACC-S2', balanceUSD: 9850, now: NOW }); // -1.5%
  assert.equal(s.conservativeMode, true);
  assert.equal(s.currentAutoConfidenceThreshold, 95);
});
