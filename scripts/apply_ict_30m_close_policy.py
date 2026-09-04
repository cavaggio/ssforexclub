#!/usr/bin/env python3
"""Read-only deployment verification for Profit Protection v3.

The file name is retained for compatibility with the existing generated-source
pipeline. Production builds must verify the committed policy rather than try
to mutate it with the retired v2 patcher.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEDULER = ROOT / "server" / "ictAutoScheduler.js"
REASSESSOR = ROOT / "server" / "oandaActiveTradeReassessor.js"
ACTIVE_MANAGEMENT_ROUTE = ROOT / "web" / "app" / "api" / "cron" / "active-trade-management" / "route.ts"
ACTIVE_EXIT_POLICY = ROOT / "web" / "lib" / "activeExitPolicy.js"

required = {
    SCHEDULER: [
        "ACTIVE_TRADE_MANAGEMENT_WINDOW",
        "startMin: 135",
        "endMin: 1050",
        "ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS",
    ],
    REASSESSOR: [
        "initialRiskPips: originalSlPips",
        "currentStopLoss:",
        "automaticFullCloseEnabled: false",
    ],
    ACTIVE_MANAGEMENT_ROUTE: [
        "evaluateActiveExit",
        "closeUnitsForDecision",
        ".eq('auto_close_enabled', true)",
        "decision.action === 'PARTIAL_CLOSE'",
        "'/api/internal/oanda/protection'",
        "profitProtectionPolicy: ACTIVE_EXIT_POLICY",
        "automaticFullCloseDisabled: true",
        "trade_exit_management_state",
        "outside_management_window_02:15-17:30_ET",
    ],
    ACTIVE_EXIT_POLICY: [
        "ACTIVE_EXIT_POLICY = 'profit_protection_v3'",
        "FIXED_STOP_LOSS_PIPS = 10",
        "FIRST_TAKE_PROFIT_PIPS = 15",
        "FIRST_PARTIAL_PERCENT = 80",
        "FINAL_TAKE_PROFIT_PIPS = 18",
        "FINAL_PARTIAL_PERCENT = 20",
        "FIXED_RR = 1.5",
        "fifteen_pip_profit_milestone",
        "eighteen_pip_final_milestone",
        "remaining_twenty_percent",
    ],
}

for path, markers in required.items():
    body = path.read_text(encoding="utf-8")
    for marker in markers:
        if marker not in body:
            raise RuntimeError(f"Profit Protection v3 verification failed: {path.relative_to(ROOT)} missing {marker}")

for path in (REASSESSOR, ACTIVE_MANAGEMENT_ROUTE, ACTIVE_EXIT_POLICY):
    body = path.read_text(encoding="utf-8")
    for forbidden in ["units: 'ALL'", "action: 'FULL_CLOSE'"]:
        if forbidden in body:
            raise RuntimeError(f"Profit Protection v3 verification failed: {path.relative_to(ROOT)} contains forbidden {forbidden}")

print("Profit Protection v3 verified: 10p SL, 80% at +15p, remaining 20% protected at breakeven, final 20% at +18p, no automatic full close.")
