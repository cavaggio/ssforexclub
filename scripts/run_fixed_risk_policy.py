#!/usr/bin/env python3
"""Idempotently materialize the fixed-risk policy after other source generators."""

from pathlib import Path
import runpy

ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / "scripts" / "enforce_fixed_risk_20pip.py"

TARGETS = (
    ("server/riskManager.js", "maxRiskPerTradePercent: FIXED_RISK_PER_TRADE_PERCENT", "patch_risk_manager"),
    ("server/oandaRiskSizing.js", "lossQuoteHomeConversionFactor = null", "patch_risk_sizing"),
    ("server/oandaTrade.js", "[FIXED_RISK_POLICY]", "patch_oanda_trade"),
    ("server/ictExecution.js", "enforcedStopLoss", "patch_ict_execution"),
)


def has_marker(relative_path: str, marker: str) -> bool:
    return marker in (ROOT / relative_path).read_text()


missing = [(rel, marker, function_name) for rel, marker, function_name in TARGETS if not has_marker(rel, marker)]

if not missing:
    print("[fixed-risk-20pip] authoritative source already materialized; no changes required")
else:
    # Load the generator as a library so a partially regenerated tree only runs
    # the patch functions whose authoritative markers are actually missing.
    generator = runpy.run_path(str(GENERATOR), run_name="fixed_risk_generator")
    for relative_path, marker, function_name in missing:
        print(f"[fixed-risk-20pip] restoring {relative_path}")
        generator[function_name]()
        if not has_marker(relative_path, marker):
            raise RuntimeError(f"Fixed-risk generator did not materialize {relative_path}")

    remaining = [rel for rel, marker, _ in TARGETS if not has_marker(rel, marker)]
    if remaining:
        raise RuntimeError(f"Fixed-risk policy is incomplete after generation: {remaining}")

    print("[fixed-risk-20pip] policy enforced: risk=1.25%, stop=20 pips")
