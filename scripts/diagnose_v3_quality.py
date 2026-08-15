
from __future__ import annotations

from pathlib import Path
import os
import re
import shutil
import subprocess
import sys


ROOT = Path.cwd()

checks = {
    "server/v3QualityConfirmation.js": [
        "evaluateV3SetupStage",
        "evaluateV3TriggerStage",
        "evaluateV3FreshExecutionStage",
    ],
    "server/v3AutoTrade.js": [
        "quality-ready pair=",
        "quality-watch pair=",
        "evaluateV3TriggerStage",
    ],
    "server/oandaTrade.js": [
        "V3_QUALITY_STAGE_3",
        "evaluateV3FreshExecutionStage",
        "getPricing",
    ],
    "server/oandaScanner.js": [
        "FOREX_PERFECT_ALIGNMENT_BYPASS_ENABLED",
        "envBool('FOREX_ACTIVE_WINDOW_V3_BRIDGE', false)",
    ],
}

failed = False
print("=== V3 QUALITY-CONFIRMATION STATIC DIAGNOSTIC ===")
for relative, markers in checks.items():
    path = ROOT / relative
    if not path.exists():
        print(f"❌ {relative}: missing")
        failed = True
        continue

    text = path.read_text(encoding="utf-8")
    missing = [marker for marker in markers if marker not in text]
    if missing:
        print(f"❌ {relative}: missing markers: {missing}")
        failed = True
    else:
        print(f"✅ {relative}")

env_defaults = {
    "FOREX_ACTIVE_WINDOW_V3_BRIDGE": "false",
    "FOREX_PERFECT_ALIGNMENT_BYPASS_ENABLED": "false",
    "V3_QUALITY_SETUP_MIN_SCORE": "65",
    "V3_QUALITY_SETUP_MIN_CONFIDENCE": "75",
    "V3_QUALITY_TRIGGER_MIN_SUPPORTS": "1",
    "V3_QUALITY_MAX_SIGNAL_AGE_SEC": "600",
    "V3_QUALITY_MAX_PRICE_DRIFT_ATR": "0.15",
    "V3_QUALITY_MAX_ENTRY_DISTANCE": "0.55",
    "FOREX_MIN_EXECUTABLE_RR": "1.5",
}

print("\n=== RECOMMENDED RAILWAY VARIABLES ===")
for key, fallback in env_defaults.items():
    print(f"{key}={os.environ.get(key, fallback)}")

node = shutil.which("node")
if node:
    print("\n=== NODE SYNTAX CHECKS ===")
    for relative in [
        "server/v3QualityConfirmation.js",
        "server/v3AutoTrade.js",
        "server/oandaTrade.js",
        "server/oandaScanner.js",
    ]:
        proc = subprocess.run(
            [node, "--check", str(ROOT / relative)],
            text=True,
            capture_output=True,
        )
        if proc.returncode == 0:
            print(f"✅ node --check {relative}")
        else:
            print(f"❌ node --check {relative}\n{proc.stderr}")
            failed = True

    test_path = ROOT / "server/v3QualityConfirmation.test.js"
    if test_path.exists():
        print("\n=== QUALITY-GATE UNIT TESTS ===")
        proc = subprocess.run(
            [node, "--test", str(test_path)],
            text=True,
            capture_output=True,
        )
        print(proc.stdout)
        if proc.returncode != 0:
            print(proc.stderr)
            failed = True
else:
    print("\n⚠️ Node was not found; syntax and unit tests were skipped.")

print("\n=== LIVE LOG FILTER ===")
print(
    'npx @railway/cli@latest logs --service "ssforexclub" --lines 2500 | '
    'grep -E "quality-ready|quality-watch|quality-reject|V3_QUALITY_STAGE_3|'
    'Stage-3 fresh execution rejected|trade executed|execution skipped|FINAL_REJECT"'
)

raise SystemExit(1 if failed else 0)
