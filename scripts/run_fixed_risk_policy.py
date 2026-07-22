#!/usr/bin/env python3
"""Idempotently materialize the fixed-risk policy after other source generators."""

from pathlib import Path
import runpy
import subprocess

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


def restore_from_head(relative_path: str, marker: str) -> bool:
    """Restore the reviewed committed version when another generator rewrote it."""
    try:
        result = subprocess.run(
            ["git", "show", f"HEAD:{relative_path}"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return False

    if marker not in result.stdout:
        return False

    (ROOT / relative_path).write_text(result.stdout)
    print(f"[fixed-risk-20pip] restored authoritative HEAD version of {relative_path}")
    return True


missing = [(rel, marker, function_name) for rel, marker, function_name in TARGETS if not has_marker(rel, marker)]

if not missing:
    print("[fixed-risk-20pip] authoritative source already materialized; no changes required")
else:
    generator = None
    for relative_path, marker, function_name in missing:
        if restore_from_head(relative_path, marker):
            continue

        # Build/container fallbacks may omit .git. In that case, patch only the
        # missing file instead of re-applying every source transformation.
        if generator is None:
            generator = runpy.run_path(str(GENERATOR), run_name="fixed_risk_generator")
        print(f"[fixed-risk-20pip] regenerating {relative_path}")
        generator[function_name]()
        if not has_marker(relative_path, marker):
            raise RuntimeError(f"Fixed-risk generator did not materialize {relative_path}")

    remaining = [rel for rel, marker, _ in TARGETS if not has_marker(rel, marker)]
    if remaining:
        raise RuntimeError(f"Fixed-risk policy is incomplete after generation: {remaining}")

    print("[fixed-risk-20pip] policy enforced: risk=1.25%, stop=20 pips")
