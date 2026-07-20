#!/usr/bin/env python3
"""Production bootstrap for autonomous execution.

Applies the repository's idempotent execution-alignment passes before Node loads any
engine modules, verifies that the generated runtime contains the required execution
contracts, validates critical non-secret environment flags, and then replaces this
process with the trading server.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

PATCHES = [
    "scripts/apply_ict_execution_alignment.py",
    "scripts/apply_ict_auto_execution_floor_alignment.py",
    "scripts/apply_ppr_live_execution_alignment.py",
    "scripts/apply_qualified_scan_execution.py",
]


def truthy(value: str | None, default: bool = False) -> bool:
    if value is None or not value.strip():
        return default
    return value.strip().lower() in {"1", "true", "yes", "on", "enabled", "active"}


def fail(message: str) -> None:
    print(f"[EXECUTION_BOOTSTRAP][FATAL] {message}", file=sys.stderr, flush=True)
    raise SystemExit(78)


def require_env(name: str) -> None:
    if not os.environ.get(name, "").strip():
        fail(f"required environment variable {name} is missing")


def require_source_markers(relative_path: str, markers: list[str]) -> None:
    path = ROOT / relative_path
    if not path.exists():
        fail(f"required runtime source is missing: {relative_path}")
    text = path.read_text(encoding="utf-8")
    missing = [marker for marker in markers if marker not in text]
    if missing:
        fail(f"{relative_path} is missing execution contract marker(s): {missing}")


print("[EXECUTION_BOOTSTRAP] applying deterministic execution alignment", flush=True)
for relative_script in PATCHES:
    script = ROOT / relative_script
    if not script.exists():
        fail(f"required patch script is missing: {relative_script}")
    completed = subprocess.run(
        [sys.executable, str(script)],
        cwd=ROOT,
        text=True,
        capture_output=True,
    )
    if completed.stdout.strip():
        print(completed.stdout.strip(), flush=True)
    if completed.returncode != 0:
        if completed.stderr.strip():
            print(completed.stderr.strip(), file=sys.stderr, flush=True)
        fail(f"execution alignment failed in {relative_script}")

# Fail the deployment instead of starting an apparently healthy but inert bot.
ict_mode = os.environ.get("ICT_ENGINE_MODE", "shadow").strip().lower()
if ict_mode not in {"active", "live"}:
    fail(f"ICT_ENGINE_MODE must be active or live, got {ict_mode!r}")
if not truthy(os.environ.get("ICT_AUTO_TRADE_ENABLED")):
    fail("ICT_AUTO_TRADE_ENABLED must be true")
if not truthy(os.environ.get("FOREX_AUTO_TRADE_ENABLED")):
    fail("FOREX_AUTO_TRADE_ENABLED must be true for V3/PPR broker submission")

v3_mode = os.environ.get("FOREX_V3_ENGINE_MODE", "off").strip().lower()
if v3_mode != "active":
    fail(f"FOREX_V3_ENGINE_MODE must be active, got {v3_mode!r}")

ppr_mode = os.environ.get("PPR_ENGINE_MODE", "active").strip().lower()
if ppr_mode not in {"active", "live"}:
    fail(f"PPR_ENGINE_MODE must be active or live, got {ppr_mode!r}")
if not truthy(os.environ.get("PPR_AI_AUTO_EXECUTION_ENABLED"), default=True):
    fail("PPR_AI_AUTO_EXECUTION_ENABLED must not be disabled")
if not truthy(os.environ.get("ICT_AUTO_AI_SCHEDULER_ENABLED"), default=True):
    fail("ICT_AUTO_AI_SCHEDULER_ENABLED must not be disabled")

for required_name in ("NEXT_BASE_URL", "AUTO_AI_CRON_SECRET", "SCANNER_INTERNAL_SECRET"):
    require_env(required_name)

require_source_markers(
    "server/ictEngine.js",
    [
        "ICT_MODE === 'active'",
        "(c.mode === 'active' || c.mode === 'live') && c.autoTradeEnabled === true",
        "executionMinConfidence: executionConfig.minConfidence",
        "executionMinRR: executionConfig.minRR",
    ],
)
require_source_markers(
    "server/ictAutoTrade.js",
    [
        "export function isIctAutoQualified",
        "rr >= cfg.minRR",
        "analyses.filter((analysis) => isIctAutoQualified(analysis, cfg))",
    ],
)
require_source_markers(
    "server/ictExecution.js",
    [
        "config.mode === 'active' || config.mode === 'live'",
        "autoExecutionMinConfidence: config.minConfidence",
        "reserveExecution",
        "stopLossOnFill",
        "takeProfitOnFill",
    ],
)
require_source_markers(
    "server/oandaTrade.js",
    [
        "const lastTradeTimesByPair = new Map();",
        "export function isPairTradeCooldownActive",
        "Pair cooldown active for ${pair}",
        "markPairTradeCooldown(pair, lastTradeTime)",
    ],
)
require_source_markers(
    "server/index.js",
    [
        "const autoExecute = req.body?.autoExecute === true;",
        "allQualifiedAttempted",
        "runAutoForUser({ client, engine",
    ],
)
require_source_markers(
    "web/app/api/cron/auto-ai-trading-extended/route.ts",
    [
        "const AUTO_AI_ENGINES: readonly AutoAiEngine[] = ['ict', 'v3', 'ppr'];",
        "for (const engine of executionOrder(preferredEngine))",
        "executionMode: 'all_engines_sequential'",
    ],
)

print(
    "[EXECUTION_BOOTSTRAP] READY "
    f"ictMode={ict_mode} ictAuto=true v3Mode={v3_mode} pprMode={ppr_mode} "
    "allEnginesSequential=true pairScopedCooldown=true qualifiedExecutionAligned=true "
    f"liveAckConfigured={truthy(os.environ.get('FOREX_ALLOW_LIVE_EXECUTION'))}",
    flush=True,
)

os.chdir(ROOT)
os.execvp("node", ["node", "server/index.js"])
