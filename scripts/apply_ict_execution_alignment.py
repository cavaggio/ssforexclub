#!/usr/bin/env python3
"""Align ICT scanner qualification and execution with the active-mode contract.

The dashboard and Auto AI runner must use the same confidence/R:R floors, and
ICT_ENGINE_MODE=active must authorize execution on the selected practice/paper
account when ICT_AUTO_TRADE_ENABLED=true. Live-only acknowledgement remains
required only when the selected broker environment is live.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "server" / "ictEngine.js"
AUTO = ROOT / "server" / "ictAutoTrade.js"
EXECUTION = ROOT / "server" / "ictExecution.js"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise RuntimeError(f"ICT execution alignment marker missing: {label}")
    return text.replace(old, new, 1)


engine = ENGINE.read_text(encoding="utf-8")
engine = engine.replace(
    "minConfidence: Math.max(85, parseFloat(process.env.ICT_MIN_CONFIDENCE || '85'))",
    "minConfidence: Math.max(80, parseFloat(process.env.ICT_EXECUTION_MIN_CONFIDENCE || '80'))",
)
engine = engine.replace(
    "minConfidence: Math.max(80, parseFloat(process.env.ICT_MIN_CONFIDENCE || '80'))",
    "minConfidence: Math.max(80, parseFloat(process.env.ICT_EXECUTION_MIN_CONFIDENCE || '80'))",
)
engine = engine.replace(
    "minConfidence: Math.max(93, parseFloat(process.env.ICT_MIN_CONFIDENCE || '93'))",
    "minConfidence: Math.max(80, parseFloat(process.env.ICT_EXECUTION_MIN_CONFIDENCE || '80'))",
)
engine = engine.replace(
    "minRR: parseFloat(process.env.ICT_MIN_RR || '2.0')",
    "minRR: parseFloat(process.env.ICT_MIN_RR || '1.5')",
)
engine = engine.replace(
    "const MIN_RR = parseFloat(process.env.ICT_MIN_RR || '2.0');",
    "const MIN_RR = parseFloat(process.env.ICT_MIN_RR || '1.5');",
)
engine = engine.replace(
    "export function isIctEnabled() { return ICT_MODE === 'shadow' || ICT_MODE === 'live'; }",
    "export function isIctEnabled() { return ICT_MODE === 'shadow' || ICT_MODE === 'active' || ICT_MODE === 'live'; }",
)
engine = engine.replace(
    "  return c.mode === 'live' && c.autoTradeEnabled === true;",
    "  return (c.mode === 'active' || c.mode === 'live') && c.autoTradeEnabled === true;",
)
engine = replace_once(
    engine,
    "  return {\n    analyses,\n    meta: {\n      ictEngineMode: ICT_MODE,\n      executionEnabled: isIctExecutionEnabled(),",
    "  const executionConfig = ictExecConfig();\n\n"
    "  return {\n    analyses,\n    meta: {\n      ictEngineMode: ICT_MODE,\n"
    "      executionEnabled: isIctExecutionEnabled(),\n"
    "      executionMinConfidence: executionConfig.minConfidence,\n"
    "      executionMinRR: executionConfig.minRR,",
    "ICT batch response execution thresholds",
)

# The R:R runtime hardening now exposes configuredIctMinRR() instead of leaving
# a raw parseFloat expression in ictEngine.js. Accept either representation so
# this older alignment pass remains idempotent and cannot fail the build after
# the stricter R:R patch has already run.
rr_marker_present = (
    "parseFloat(process.env.ICT_MIN_RR || '1.5')" in engine
    or "configuredIctMinRR()" in engine
)

# The authoritative operational floor is 80%. Accept legacy source forms so this
# compatibility pass can normalize an older tree, but require the final runtime
# form to use the execution-specific environment variable.
confidence_marker_present = (
    "Math.max(80, parseFloat(process.env.ICT_EXECUTION_MIN_CONFIDENCE || '80'))" in engine
    or "Math.max(80, parseFloat(process.env.ICT_MIN_CONFIDENCE || '80'))" in engine
    or "Math.max(93, parseFloat(process.env.ICT_MIN_CONFIDENCE || '93'))" in engine
    or "minConfidence: 80," in engine
)

for marker in [
    "ICT_MODE === 'active'",
    "(c.mode === 'active' || c.mode === 'live') && c.autoTradeEnabled === true",
    "executionMinConfidence: executionConfig.minConfidence",
    "executionMinRR: executionConfig.minRR",
]:
    if marker not in engine:
        raise RuntimeError(f"ICT engine alignment incomplete: missing {marker}")
if not confidence_marker_present:
    raise RuntimeError("ICT engine alignment incomplete: missing configured ICT confidence contract")
if not rr_marker_present:
    raise RuntimeError(
        "ICT engine alignment incomplete: missing configured ICT minimum R:R contract"
    )

ENGINE.write_text(engine, encoding="utf-8")


auto = AUTO.read_text(encoding="utf-8")
qualification_helper = (
    "export function isIctAutoQualified(analysis, cfg = ictExecConfig()) {\n"
    "  const confidence = Number(analysis?.confidence);\n"
    "  const rr = Number(analysis?.rr);\n"
    "  return analysis?.signal !== 'none' &&\n"
    "    Number.isFinite(confidence) && confidence >= cfg.minConfidence &&\n"
    "    Number.isFinite(rr) && rr >= cfg.minRR;\n"
    "}\n\n"
)
if "export function isIctAutoQualified" not in auto:
    match = re.search(
        r"(?=function buildIctWatchState\(analyses = \[\], minConfidence = \d+\) \{)",
        auto,
    )
    if not match:
        raise RuntimeError(
            "ICT execution alignment marker missing: ICT autonomous qualification helper"
        )
    auto = auto[: match.start()] + qualification_helper + auto[match.start() :]

auto = replace_once(
    auto,
    "  const qualified = analyses.filter((a) => a.signal !== 'none' && a.confidence >= cfg.minConfidence);",
    "  const qualified = analyses.filter((analysis) => isIctAutoQualified(analysis, cfg));",
    "ICT autonomous qualification filter",
)

for marker in [
    "export function isIctAutoQualified",
    "confidence >= cfg.minConfidence",
    "rr >= cfg.minRR",
    "analyses.filter((analysis) => isIctAutoQualified(analysis, cfg))",
]:
    if marker not in auto:
        raise RuntimeError(f"ICT Auto AI alignment incomplete: missing {marker}")

AUTO.write_text(auto, encoding="utf-8")


execution = EXECUTION.read_text(encoding="utf-8")
execution = execution.replace(
    "requires ICT_ENGINE_MODE=live AND ICT_AUTO_TRADE_ENABLED=true,",
    "requires ICT_ENGINE_MODE=active (or legacy live) AND ICT_AUTO_TRADE_ENABLED=true,",
)
execution = execution.replace(
    "// ── 1. Execution enabled (mode=live AND auto-trade) — the default-off gate ──",
    "// ── 1. Execution enabled (mode=active/live AND auto-trade) ────────────────",
)
execution = execution.replace(
    "  if (!(config.mode === 'live' && config.autoTradeEnabled === true)) {",
    "  if (!((config.mode === 'active' || config.mode === 'live') && config.autoTradeEnabled === true)) {",
)

for marker in [
    "requires ICT_ENGINE_MODE=active (or legacy live)",
    "config.mode === 'active' || config.mode === 'live'",
    "ICT execution disabled (ICT_ENGINE_MODE=${config.mode}",
]:
    if marker not in execution:
        raise RuntimeError(f"ICT executor active-mode alignment incomplete: missing {marker}")

EXECUTION.write_text(execution, encoding="utf-8")
print("ICT execution aligned: active mode executes qualified practice/paper trades; live safeguards remain live-only")
