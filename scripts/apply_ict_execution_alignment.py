#!/usr/bin/env python3
"""Align ICT scanner qualification with the autonomous execution contract.

The dashboard and Auto AI runner must use the same confidence and R:R floors.
This patch is idempotent because repository pretest/prebuild/prestart workflows
regenerate and enforce source before every validation and deployment.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "server" / "ictEngine.js"
AUTO = ROOT / "server" / "ictAutoTrade.js"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise RuntimeError(f"ICT execution alignment marker missing: {label}")
    return text.replace(old, new, 1)


engine = ENGINE.read_text(encoding="utf-8")
engine = engine.replace(
    "minConfidence: Math.max(85, parseFloat(process.env.ICT_MIN_CONFIDENCE || '85'))",
    "minConfidence: Math.max(80, parseFloat(process.env.ICT_MIN_CONFIDENCE || '80'))",
)
engine = engine.replace(
    "minRR: parseFloat(process.env.ICT_MIN_RR || '2.0')",
    "minRR: parseFloat(process.env.ICT_MIN_RR || '1.5')",
)
engine = engine.replace(
    "const MIN_RR = parseFloat(process.env.ICT_MIN_RR || '2.0');",
    "const MIN_RR = parseFloat(process.env.ICT_MIN_RR || '1.5');",
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

for marker in [
    "Math.max(80, parseFloat(process.env.ICT_MIN_CONFIDENCE || '80'))",
    "parseFloat(process.env.ICT_MIN_RR || '1.5')",
    "executionMinConfidence: executionConfig.minConfidence",
    "executionMinRR: executionConfig.minRR",
]:
    if marker not in engine:
        raise RuntimeError(f"ICT engine alignment incomplete: missing {marker}")

ENGINE.write_text(engine, encoding="utf-8")


auto = AUTO.read_text(encoding="utf-8")
auto = replace_once(
    auto,
    "}\n\nfunction buildIctWatchState(analyses = [], minConfidence = 85) {",
    "}\n\n"
    "export function isIctAutoQualified(analysis, cfg = ictExecConfig()) {\n"
    "  const confidence = Number(analysis?.confidence);\n"
    "  const rr = Number(analysis?.rr);\n"
    "  return analysis?.signal !== 'none' &&\n"
    "    Number.isFinite(confidence) && confidence >= cfg.minConfidence &&\n"
    "    Number.isFinite(rr) && rr >= cfg.minRR;\n"
    "}\n\n"
    "function buildIctWatchState(analyses = [], minConfidence = 85) {",
    "ICT autonomous qualification helper",
)
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
print("ICT execution alignment enforced: confidence/RR-qualified rows match Auto AI attempts")
