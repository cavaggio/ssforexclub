#!/usr/bin/env python3
"""Add an authenticated, account-scoped daily risk reset endpoint."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RISK = ROOT / "server" / "riskManager.js"
INDEX = ROOT / "server" / "index.js"

risk = RISK.read_text(encoding="utf-8")
old_reset = """export function resetDailyRisk() {
  const cleared = dailyState.size;
  dailyState.clear();
  console.log(`[DAILY RISK LOCK] reset — cleared ${cleared} account baseline(s)`);
  return { ok: true, cleared };
}"""
new_reset = """export function resetDailyRisk(accountId = null) {
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
}"""
if new_reset not in risk:
    if old_reset not in risk:
        raise RuntimeError("daily risk reset function marker missing")
    risk = risk.replace(old_reset, new_reset, 1)
RISK.write_text(risk, encoding="utf-8")

index = INDEX.read_text(encoding="utf-8")
index = index.replace(
    "import { getRiskStatus } from './riskManager.js';",
    "import { getRiskStatus, resetDailyRisk } from './riskManager.js';",
)

route = """
// POST /api/internal/oanda/risk-reset
//   Authenticated account-scoped reset of today's in-memory daily-loss baseline.
//   The new baseline is immediately re-seeded from the broker's current balance.
app.post('/api/internal/oanda/risk-reset', async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const client = buildClientFromBody(req.body, res);
  if (!client) return;
  assertClientMatchesRequest(client, req.body);
  logInternalCall('RISK_RESET', req.body);
  try {
    const account = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => getAccountSummary({ client }),
    );
    const balanceUSD = parseFloat(account?.balance ?? 0);
    const reset = resetDailyRisk(client.accountId);
    const status = getRiskStatus({ accountId: client.accountId, balanceUSD });
    console.log(
      `[INTERNAL_RISK_RESET] accountId=${maskAccountId(client.accountId)} ` +
      `startingBalance=${status.dailyStartingBalance} tradingLocked=${status.tradingLocked}`,
    );
    res.json({ ok: true, reset, ...status });
  } catch (err) {
    console.error('[INTERNAL_RISK_RESET] error:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

"""
marker = "// POST /api/internal/oanda/scan\n"
if route not in index:
    if marker not in index:
        raise RuntimeError("risk reset insertion marker missing")
    index = index.replace(marker, route + marker, 1)

for expected in [
    "getRiskStatus, resetDailyRisk",
    "/api/internal/oanda/risk-reset",
    "resetDailyRisk(client.accountId)",
    "[INTERNAL_RISK_RESET]",
]:
    if expected not in index:
        raise RuntimeError(f"risk reset endpoint incomplete: missing {expected}")
INDEX.write_text(index, encoding="utf-8")

print("Account-scoped daily risk reset endpoint enforced")
