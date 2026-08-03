#!/usr/bin/env python3
"""Enforce Active Exit Intelligence v1.

The filename is retained for compatibility with the existing generated-source
pipeline. The policy now reviews open trades every five minutes from 02:15 to
17:30 ET. Broker actions remain centralized in the authenticated Next.js route;
the generic Railway reassessor is still recommendation-only.
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


# Keep the broad reassessor recommendation-only. The authenticated cron route is
# the only path allowed to send full or partial close requests.
reassessor = REASSESSOR.read_text(encoding="utf-8")
if "const DIRECT_REASSESSOR_BROKER_CLOSE_ENABLED = false;" not in reassessor:
    raise RuntimeError("Active Exit Intelligence requires direct reassessor closes to remain disabled")
if "DIRECT_REASSESSOR_BROKER_CLOSE_ENABLED && AUTO_CLOSE_ENABLED" not in reassessor:
    raise RuntimeError("Active Exit Intelligence reassessor gate is missing")
for marker in ["initialRiskPips: originalSlPips", "currentStopLoss:"]:
    if marker not in reassessor:
        raise RuntimeError(f"Active Exit Intelligence reassessor incomplete: missing {marker}")
REASSESSOR.write_text(reassessor, encoding="utf-8")


route = ACTIVE_MANAGEMENT_ROUTE.read_text(encoding="utf-8")
for marker in [
    "evaluateActiveExit",
    "closeUnitsForDecision",
    ".eq('auto_close_enabled', true)",
    "decision.action === 'PARTIAL_CLOSE'",
    "active_exit_intelligence_v1",
    "trade_exit_management_state",
    "outside_management_window_02:15-17:30_ET",
]:
    if marker not in route:
        raise RuntimeError(f"Active Exit Intelligence route incomplete: missing {marker}")
if "ict_30m_high_reversal_near_sl_only" in route:
    raise RuntimeError("Retired ICT near-SL-only policy remains in the active-management route")
ACTIVE_MANAGEMENT_ROUTE.write_text(route, encoding="utf-8")

print("Active Exit Intelligence enforced: 5m reviews, user toggle, one partial, full invalidation exits")
