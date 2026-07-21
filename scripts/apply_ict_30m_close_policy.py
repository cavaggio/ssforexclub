#!/usr/bin/env python3
"""Enforce the ICT active-trade close policy.

ICT scans may continue to reassess open positions, but scanner rejection, falling
confidence, ordinary trend weakness, or a generic EXIT_REVIEW must never close an
ICT trade. Broker closes are owned by the authenticated active-management route,
which requires a 30-minute reassessment, explicit HIGH reversal/invalidation risk,
an explicit CLOSE/EXIT recommendation, and price inside the final 25% of the
original stop distance.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEDULER = ROOT / "server" / "ictAutoScheduler.js"
REASSESSOR = ROOT / "server" / "oandaActiveTradeReassessor.js"
ACTIVE_MANAGEMENT_ROUTE = ROOT / "web" / "app" / "api" / "cron" / "active-trade-management" / "route.ts"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise RuntimeError(f"ICT 30m close policy marker missing: {label}")
    return text.replace(old, new, 1)


scheduler = SCHEDULER.read_text(encoding="utf-8")
scheduler = replace_once(
    scheduler,
    "export const ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS = interval('ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS', 300000);",
    "export const ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS = interval('ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS', 1800000);",
    "30-minute management cadence",
)
scheduler = replace_once(
    scheduler,
    "  void activeTradeManagementTick(nextUrl, secret);\n  void transactionSyncTick(nextUrl, secret);",
    "  // Do not run active management immediately on process startup. The first\n"
    "  // close-capable review must occur on the 30-minute scheduler cadence.\n"
    "  void transactionSyncTick(nextUrl, secret);",
    "remove startup auto-close review",
)
for marker in [
    "ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS', 1800000",
    "The first close-capable review must occur on the 30-minute scheduler cadence",
]:
    if marker not in scheduler:
        raise RuntimeError(f"ICT scheduler policy incomplete: missing {marker}")
SCHEDULER.write_text(scheduler, encoding="utf-8")


reassessor = REASSESSOR.read_text(encoding="utf-8")
reassessor = replace_once(
    reassessor,
    "const REASSESSMENT_INTERVAL_MS = Number(process.env.ACTIVE_TRADE_REASSESS_INTERVAL_MS || 15 * 60 * 1000); // 15 min — active management cadence",
    "const REASSESSMENT_INTERVAL_MS = Number(process.env.ACTIVE_TRADE_REASSESS_INTERVAL_MS || 30 * 60 * 1000); // 30 min — active management cadence",
    "reassessor 30-minute cadence",
)
reassessor = replace_once(
    reassessor,
    "const AUTO_CLOSE_ENABLED =\n  String(process.env.ENABLE_ACTIVE_TRADE_AUTO_CLOSE || 'false').toLowerCase() === 'true';",
    "const AUTO_CLOSE_ENABLED =\n"
    "  String(process.env.ENABLE_ACTIVE_TRADE_AUTO_CLOSE || 'false').toLowerCase() === 'true';\n\n"
    "// The generic reassessor is recommendation-only. Actual authenticated broker\n"
    "// closes are centralized in /api/cron/active-trade-management, which enforces\n"
    "// the ICT 30m + HIGH reversal + near-SL policy. This prevents a second, broad\n"
    "// auto-close path from acting on scan rejection or confidence deterioration.\n"
    "const DIRECT_REASSESSOR_BROKER_CLOSE_ENABLED = false;",
    "disable generic direct broker closes",
)
reassessor = replace_once(
    reassessor,
    "  if (AUTO_CLOSE_ENABLED && isPostEntryManagementWindow(new Date())) {",
    "  if (DIRECT_REASSESSOR_BROKER_CLOSE_ENABLED && AUTO_CLOSE_ENABLED && isPostEntryManagementWindow(new Date())) {",
    "generic reassessor close gate",
)
reassessor = replace_once(
    reassessor,
    "    distanceToTP: distToTpPips,\n    distanceToSL: distToSlPips,",
    "    distanceToTP: distToTpPips,\n"
    "    distanceToSL: distToSlPips,\n"
    "    currentStopLoss: Number.isFinite(currentSL) ? currentSL : null,\n"
    "    originalStopLoss: Number.isFinite(originalSL) ? originalSL : null,\n"
    "    initialRiskPips: originalSlPips,",
    "expose stop-proximity fields",
)
reassessor = reassessor.replace(
    "// PART 10 — 15-MINUTE SCHEDULER (env-guarded, hot-reload-safe)",
    "// PART 10 — 30-MINUTE SCHEDULER (env-guarded, hot-reload-safe)",
)
reassessor = reassessor.replace(
    " * Start the 15-min reassessment loop. Idempotent — calling twice doesn't",
    " * Start the 30-min reassessment loop. Idempotent — calling twice doesn't",
)
reassessor = reassessor.replace(
    "[REASSESSOR] Starting 15-min active-trade reassessment scheduler",
    "[REASSESSOR] Starting 30-min active-trade reassessment scheduler",
)

for marker in [
    "30 * 60 * 1000); // 30 min — active management cadence",
    "const DIRECT_REASSESSOR_BROKER_CLOSE_ENABLED = false;",
    "DIRECT_REASSESSOR_BROKER_CLOSE_ENABLED && AUTO_CLOSE_ENABLED",
    "initialRiskPips: originalSlPips",
    "currentStopLoss:",
]:
    if marker not in reassessor:
        raise RuntimeError(f"ICT reassessor policy incomplete: missing {marker}")
REASSESSOR.write_text(reassessor, encoding="utf-8")


route = ACTIVE_MANAGEMENT_ROUTE.read_text(encoding="utf-8")
# Next.js route modules may export only supported route/config symbols. Keep the
# policy helper module-local while retaining source-level regression visibility.
route = route.replace(
    "export function shouldCloseIctTrade(plan: Record<string, any>): CloseDecision {",
    "function shouldCloseIctTrade(plan: Record<string, any>): CloseDecision {",
    1,
)
for marker in [
    "function shouldCloseIctTrade(plan: Record<string, any>): CloseDecision",
    "ICT_MIN_REASSESSMENT_AGE_MINUTES = 30",
    "ict_30m_high_reversal_near_sl_only",
]:
    if marker not in route:
        raise RuntimeError(f"ICT active-management route incomplete: missing {marker}")
if "export function shouldCloseIctTrade" in route:
    raise RuntimeError("ICT active-management route exports an unsupported Next.js helper")
ACTIVE_MANAGEMENT_ROUTE.write_text(route, encoding="utf-8")

print("ICT close policy enforced: 30m cadence, no generic direct closes, stop proximity exposed")
