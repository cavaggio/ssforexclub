#!/usr/bin/env python3
"""Keep ICT scan qualification and autonomous execution on the same confidence floor.

The ICT scanner owns its engine-specific confidence threshold. The shared risk manager
must not silently impose a higher confidence floor after a setup has already been
classified as qualified. Hard risk, margin, drawdown, duplicate, spread, news, and
minimum-R:R protections remain unchanged.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXECUTION = ROOT / "server" / "ictExecution.js"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise RuntimeError(f"ICT auto-execution floor marker missing: {label}")
    return text.replace(old, new, 1)


execution = EXECUTION.read_text(encoding="utf-8")
execution = replace_once(
    execution,
    "  checkAutoExecutionConfidence,\n} from './riskManager.js';",
    "  checkAutoExecutionConfidence,\n  riskConfig,\n} from './riskManager.js';",
    "riskConfig import",
)
execution = replace_once(
    execution,
    "    const confCheck = checkAutoExecutionConfidence(analysis.confidence);\n"
    "    if (!confCheck.passed) return blocked(confCheck.reason);",
    "    const confCheck = checkAutoExecutionConfidence(analysis.confidence, {\n"
    "      ...riskConfig(),\n"
    "      autoExecutionMinConfidence: config.minConfidence,\n"
    "    });\n"
    "    if (!confCheck.passed) return blocked(confCheck.reason);",
    "ICT engine-specific autonomous confidence floor",
)

for marker in [
    "riskConfig,",
    "autoExecutionMinConfidence: config.minConfidence",
    "checkAutoExecutionConfidence(analysis.confidence, {",
]:
    if marker not in execution:
        raise RuntimeError(f"ICT auto-execution floor alignment incomplete: missing {marker}")

EXECUTION.write_text(execution, encoding="utf-8")
print("ICT autonomous execution floor aligned with ICT qualification threshold")
