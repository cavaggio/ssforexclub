#!/usr/bin/env python3
"""Read-only V3 production source verification.

Production builds must consume the committed V3 source as-is. Historical
mutation patchers are intentionally not executed during deployment because
those patchers can drift when their source anchors are already applied.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

required = {
    "server/primaryTimeframeAlignment.js": [
        "v3-primary-daily-h4-67-m15-100-2026-07-17",
        "export const HARD_ALIGNMENT_TIMEFRAMES = ['daily', 'h4']",
        "export const PRIMARY_ALIGNMENT_TIMEFRAMES = ['daily', 'h4', 'm15']",
        "const dailyH4Aligned = biases.daily === expected && biases.h4 === expected",
        "const score = dailyH4Aligned ? (m15Aligned ? 100 : 67)",
        "const passed = dailyH4Aligned && score >= PRIMARY_ALIGNMENT_MIN_SCORE",
    ],
    "server/v3EntryContract.js": [
        "selectExecutablePrice",
        "repriceExecutableGeometry",
        "validateDirectionLock",
    ],
    "server/v3IndependentScanner.js": [
        "deriveV3EntryTiming",
        "refreshIndependentV3CandidateForExecution",
        "candidate.directionLock",
    ],
    "server/v3AutoTrade.js": [
        "refreshIndependentV3CandidateForExecution",
    ],
    "server/oandaTrade.js": [
        "repriceExecutableGeometry",
        "buildOandaMarketOrderPayload",
        "Pure V3 execution requires a successful Stage 2 confirmation",
        "Repriced V3 geometry from",
        "const FIXED_FOREX_STOP_LOSS_PIPS = 10.0;",
        "const FIXED_FOREX_TAKE_PROFIT_PIPS = 15.0;",
    ],
}

forbidden = {
    "server/v3QualityConfirmation.js": ["export function evaluateV3FreshExecutionStage"],
    "server/oandaTrade.js": [
        "import { evaluateV3FreshExecutionStage }",
        "V3_QUALITY_STAGE_3",
        "Stage-3 fresh execution rejected",
        "FIXED_20P_FILL_REANCHOR",
    ],
}

failures = []
for relative, markers in required.items():
    body = (ROOT / relative).read_text(encoding="utf-8")
    for marker in markers:
        if marker not in body:
            failures.append(f"{relative}: missing {marker}")

for relative, markers in forbidden.items():
    body = (ROOT / relative).read_text(encoding="utf-8")
    for marker in markers:
        if marker in body:
            failures.append(f"{relative}: forbidden marker remains {marker}")

if failures:
    raise RuntimeError("V3 production source verification failed:\n- " + "\n- ".join(failures))

print("V3 production source verified: committed source is synchronized and production-safe.")
