import { test } from 'node:test';
import assert from 'node:assert/strict';

// Default thresholds (1.4% / 2.8% / 90 / 1.4% conservative).
for (const k of [
  'RISK_MAX_PER_TRADE_PERCENT', 'RISK_DAILY_MAX_DRAWDOWN_PERCENT',
  'RISK_AUTO_EXECUTION_MIN_CONFIDENCE', 'RISK_CONSERVATIVE_TRIGGER_PERCENT',
  'RISK_CONSERVATIVE_MIN_CONFIDENCE',
]) delete process.env[k];

const {
  setRiskStore,
  hydrateDailyBaseline,
  persistDailyState,
  checkDailyRiskLock,
  resetDailyRisk,
} = await import('./riskManager.js');

const DAY1 = new Date('2026-06-11T15:00:00Z'); // NY 2026-06-11
const DAY2 = new Date('2026-06-12T15:00:00Z'); // NY 2026-06-12

// In-memory fake of the Supabase-backed store (domain interface).
function makeFakeStore() {
  const rows = new Map();
  const k = (a, d) => `${a}|${d}`;
  return {
    rows,
    async load({ accountId, tradingDateKey }) {
      return rows.get(k(accountId, tradingDateKey)) ?? null;
    },
    async upsert(row) {
      rows.set(k(row.accountId, row.tradingDateKey), { ...row });
    },
  };
}

// Simulate a fresh process: clear the in-memory cache but keep the durable store.
function simulateRestart() { resetDailyRisk(); }

async function freshEnv() {
  const store = makeFakeStore();
  setRiskStore(store);
  resetDailyRisk();
  return store;
}

test('baseline survives a simulated restart (no intraday re-anchor)', async () => {
  await freshEnv();
  await hydrateDailyBaseline({ accountId: 'ACC1', balanceUSD: 10000, now: DAY1 }); // no row yet
  const s1 = checkDailyRiskLock({ accountId: 'ACC1', balanceUSD: 10000, now: DAY1 });
  await persistDailyState({ accountId: 'ACC1', status: s1, now: DAY1 });
  assert.equal(s1.startingBalance, 10000);

  simulateRestart();
  // After restart the balance is lower; hydrate must restore the TRUE start-of-day.
  await hydrateDailyBaseline({ accountId: 'ACC1', balanceUSD: 9700, now: DAY1 });
  const s2 = checkDailyRiskLock({ accountId: 'ACC1', balanceUSD: 9700, now: DAY1 });
  assert.equal(s2.startingBalance, 10000, 'must NOT re-anchor to the lower current balance');
  assert.equal(s2.realizedPnL, -300);
  assert.equal(s2.lossLimit, 280);
});

test('same account reuses the same dailyStartingBalance intraday', async () => {
  await freshEnv();
  await hydrateDailyBaseline({ accountId: 'ACC2', balanceUSD: 10000, now: DAY1 });
  const a = checkDailyRiskLock({ accountId: 'ACC2', balanceUSD: 10000, now: DAY1 });
  await persistDailyState({ accountId: 'ACC2', status: a, now: DAY1 });
  const b = checkDailyRiskLock({ accountId: 'ACC2', balanceUSD: 9950, now: DAY1 });
  assert.equal(b.startingBalance, 10000);
});

test('different broker accounts get separate baselines (survive restart)', async () => {
  await freshEnv();
  await hydrateDailyBaseline({ accountId: 'B1', balanceUSD: 10000, now: DAY1 });
  await persistDailyState({ accountId: 'B1', status: checkDailyRiskLock({ accountId: 'B1', balanceUSD: 10000, now: DAY1 }), now: DAY1 });
  await hydrateDailyBaseline({ accountId: 'B2', balanceUSD: 8000, now: DAY1 });
  await persistDailyState({ accountId: 'B2', status: checkDailyRiskLock({ accountId: 'B2', balanceUSD: 8000, now: DAY1 }), now: DAY1 });

  simulateRestart();
  await hydrateDailyBaseline({ accountId: 'B1', balanceUSD: 9000, now: DAY1 });
  await hydrateDailyBaseline({ accountId: 'B2', balanceUSD: 7000, now: DAY1 });
  assert.equal(checkDailyRiskLock({ accountId: 'B1', balanceUSD: 9000, now: DAY1 }).startingBalance, 10000);
  assert.equal(checkDailyRiskLock({ accountId: 'B2', balanceUSD: 7000, now: DAY1 }).startingBalance, 8000);
});

test('a new NY trading day creates a new baseline', async () => {
  await freshEnv();
  await hydrateDailyBaseline({ accountId: 'C1', balanceUSD: 10000, now: DAY1 });
  await persistDailyState({ accountId: 'C1', status: checkDailyRiskLock({ accountId: 'C1', balanceUSD: 10000, now: DAY1 }), now: DAY1 });

  simulateRestart();
  // New NY day → no persisted row for DAY2 → baseline anchors to current balance.
  await hydrateDailyBaseline({ accountId: 'C1', balanceUSD: 9000, now: DAY2 });
  const s = checkDailyRiskLock({ accountId: 'C1', balanceUSD: 9000, now: DAY2 });
  assert.equal(s.startingBalance, 9000);
  assert.equal(s.realizedPnL, 0);
});

test('conservative mode persists across a restart', async () => {
  await freshEnv();
  await hydrateDailyBaseline({ accountId: 'D1', balanceUSD: 10000, now: DAY1 });
  await persistDailyState({ accountId: 'D1', status: checkDailyRiskLock({ accountId: 'D1', balanceUSD: 10000, now: DAY1 }), now: DAY1 });
  // Down 1.5% → conservative (but not locked).
  const before = checkDailyRiskLock({ accountId: 'D1', balanceUSD: 9850, now: DAY1 });
  await persistDailyState({ accountId: 'D1', status: before, now: DAY1 });
  assert.equal(before.conservativeMode, true);
  assert.equal(before.tradingLocked, false);

  simulateRestart();
  await hydrateDailyBaseline({ accountId: 'D1', balanceUSD: 9850, now: DAY1 });
  const after = checkDailyRiskLock({ accountId: 'D1', balanceUSD: 9850, now: DAY1 });
  assert.equal(after.startingBalance, 10000);
  assert.equal(after.conservativeMode, true);
  assert.equal(after.activeConfidenceThreshold, 95);
});

test('trading lock persists across a restart', async () => {
  await freshEnv();
  await hydrateDailyBaseline({ accountId: 'E1', balanceUSD: 10000, now: DAY1 });
  await persistDailyState({ accountId: 'E1', status: checkDailyRiskLock({ accountId: 'E1', balanceUSD: 10000, now: DAY1 }), now: DAY1 });
  // Down 3% → locked.
  const before = checkDailyRiskLock({ accountId: 'E1', balanceUSD: 9700, now: DAY1 });
  await persistDailyState({ accountId: 'E1', status: before, now: DAY1 });
  assert.equal(before.tradingLocked, true);

  simulateRestart();
  await hydrateDailyBaseline({ accountId: 'E1', balanceUSD: 9700, now: DAY1 });
  const after = checkDailyRiskLock({ accountId: 'E1', balanceUSD: 9700, now: DAY1 });
  assert.equal(after.startingBalance, 10000);
  assert.equal(after.tradingLocked, true);
});

test('with no store configured, behaviour is unchanged (in-memory only)', async () => {
  setRiskStore(null);
  resetDailyRisk();
  const h = await hydrateDailyBaseline({ accountId: 'NS', balanceUSD: 10000, now: DAY1 });
  assert.equal(h.hydrated, false);
  const s = checkDailyRiskLock({ accountId: 'NS', balanceUSD: 10000, now: DAY1 });
  assert.equal(s.startingBalance, 10000);
  // persist is a no-op without a store (must not throw).
  const p = await persistDailyState({ accountId: 'NS', status: s, now: DAY1 });
  assert.equal(p.persisted, false);
});
