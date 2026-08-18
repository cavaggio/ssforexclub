#!/usr/bin/env python3
"""Enforce Profit Protection v2.

The filename is retained for compatibility with the existing generated-source
pipeline. The policy reviews open trades every five minutes from 02:15 to
17:30 ET, cannot liquidate a full trade, takes one 50% partial once open
profit reaches +15 pips, and limits remaining broker mutations to tighter
protection / post-target trailing.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEDULER = ROOT / "server" / "ictAutoScheduler.js"
REASSESSOR = ROOT / "server" / "oandaActiveTradeReassessor.js"
ACTIVE_MANAGEMENT_ROUTE = ROOT / "web" / "app" / "api" / "cron" / "active-trade-management" / "route.ts"
ACTIVE_EXIT_POLICY = ROOT / "web" / "lib" / "activeExitPolicy.js"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise RuntimeError(f"Active Exit Intelligence marker missing: {label}")
    return text.replace(old, new, 1)


scheduler = SCHEDULER.read_text(encoding="utf-8")
scheduler = replace_once(
    scheduler,
    "export const ACTIVE_TRADE_MANAGEMENT_WINDOW = { startMin: 600, endMin: 1050 }; // 10:00–17:30 ET",
    "export const ACTIVE_TRADE_MANAGEMENT_WINDOW = { startMin: 135, endMin: 1050 }; // 02:15–17:30 ET",
    "management window",
)
scheduler = replace_once(
    scheduler,
    "export const ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS = Math.max(1800000, interval('ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS', 1800000));",
    "export const ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS = Math.max(300000, interval('ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS', 300000));",
    "five-minute management cadence",
)
scheduler = scheduler.replace(
    "management=10:00–17:30_ET/${ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS}ms",
    "management=02:15–17:30_ET/${ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS}ms",
)
scheduler = scheduler.replace(
    "The first close-capable review must occur on the 30-minute scheduler cadence.",
    "The first close-capable review occurs on the five-minute scheduler cadence.",
)
for marker in [
    "ACTIVE_TRADE_MANAGEMENT_WINDOW = { startMin: 135, endMin: 1050 }",
    "Math.max(300000, interval('ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS', 300000))",
    "management=02:15–17:30_ET",
    "five-minute scheduler cadence",
]:
    if marker not in scheduler:
        raise RuntimeError(f"Active Exit Intelligence scheduler incomplete: missing {marker}")
SCHEDULER.write_text(scheduler, encoding="utf-8")


# Keep the broad reassessor analysis-only. It must not contain a direct broker
# liquidation path.
reassessor = REASSESSOR.read_text(encoding="utf-8")
for forbidden in ["closeBrokerTrade", "units: 'ALL'", "DIRECT_REASSESSOR_BROKER_CLOSE_ENABLED"]:
    if forbidden in reassessor:
        raise RuntimeError(f"Profit Protection v2 reassessor contains forbidden liquidation marker: {forbidden}")
for marker in ["initialRiskPips: originalSlPips", "currentStopLoss:", "automaticFullCloseEnabled: false"]:
    if marker not in reassessor:
        raise RuntimeError(f"Profit Protection v2 reassessor incomplete: missing {marker}")
REASSESSOR.write_text(reassessor, encoding="utf-8")


route = ACTIVE_MANAGEMENT_ROUTE.read_text(encoding="utf-8")
for marker in [
    "evaluateActiveExit",
    "closeUnitsForDecision",
    ".eq('auto_close_enabled', true)",
    "decision.action === 'PARTIAL_CLOSE'",
    "'/api/internal/oanda/protection'",
    "profitProtectionPolicy: ACTIVE_EXIT_POLICY",
    "automaticFullCloseDisabled: true",
    "trade_exit_management_state",
    "outside_management_window_02:15-17:30_ET",
]:
    if marker not in route:
        raise RuntimeError(f"Profit Protection v2 route incomplete: missing {marker}")
for forbidden in ["units: 'ALL'", "action: 'FULL_CLOSE'", "decision.action === 'FULL_CLOSE'"]:
    if forbidden in route:
        raise RuntimeError(f"Profit Protection v2 route contains forbidden liquidation marker: {forbidden}")
ACTIVE_MANAGEMENT_ROUTE.write_text(route, encoding="utf-8")


policy = ACTIVE_EXIT_POLICY.read_text(encoding="utf-8")
for marker in [
    "FIRST_PARTIAL_PROFIT_PIPS = 15",
    "currentProfitPips >= FIRST_PARTIAL_PROFIT_PIPS",
    "const percent = 50",
    "fifteen_pip_profit_milestone",
    "single_partial_limit",
    "breakeven_runner",
]:
    if marker not in policy:
        raise RuntimeError(f"Profit Protection v2 15-pip policy incomplete: missing {marker}")
for forbidden in ["return 'ALL'", "action: 'FULL_CLOSE'"]:
    if forbidden in policy:
        raise RuntimeError(f"Profit Protection v2 policy contains forbidden liquidation marker: {forbidden}")

print("Profit Protection v2 enforced: 5m reviews, no automatic full close, 50% partial at +15p, breakeven runner, post-TP trail")