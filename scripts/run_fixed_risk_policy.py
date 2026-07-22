#!/usr/bin/env python3
"""Run the fixed-risk source generator only when authoritative markers are absent."""

from pathlib import Path
import runpy

ROOT = Path(__file__).resolve().parents[1]

MARKERS = {
    "server/riskManager.js": "maxRiskPerTradePercent: FIXED_RISK_PER_TRADE_PERCENT",
    "server/oandaRiskSizing.js": "lossQuoteHomeConversionFactor = null",
    "server/oandaTrade.js": "[FIXED_RISK_POLICY]",
    "server/ictExecution.js": "enforcedStopLoss",
}


def is_materialized() -> bool:
    return all(marker in (ROOT / rel).read_text() for rel, marker in MARKERS.items())


if is_materialized():
    print("[fixed-risk-20pip] authoritative source already materialized; no changes required")
else:
    runpy.run_path(str(ROOT / "scripts" / "enforce_fixed_risk_20pip.py"), run_name="__main__")

    if not is_materialized():
        raise RuntimeError("Fixed-risk generator completed without materializing every enforcement marker")
