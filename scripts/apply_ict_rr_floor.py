#!/usr/bin/env python3
"""Construct every ICT setup at or above the minimum 1:1.5 R:R floor.

The ICT engine may identify a valid entry and structure-based stop while the
nearest liquidity pool produces less than 1.5R. That is not a rejection reason:
this source-enforcement pass extends take-profit to the rounded 1.5R price (or a
stricter configured floor) before scan qualification and execution.

This script is intentionally idempotent because the repository runs its source
enforcement pipeline during pretest, prebuild, prestart, and local server start.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "server" / "ictEngine.js"

POLICY_BLOCK = r"""// Signal Stack policy: R:R is a ratio, not a percentage. Every generated ICT
// setup is constructed at a minimum of 1:1.5 before qualification/execution.
export const ICT_MIN_RR = 1.5;
export function configuredIctMinRR() {
  const configured = parseFloat(process.env.ICT_MIN_RR || '1.5');
  return Number.isFinite(configured) ? Math.max(ICT_MIN_RR, configured) : ICT_MIN_RR;
}

/**
 * Extend a technically valid target to the configured minimum R:R when the
 * nearest liquidity target is too close. This changes take-profit only; the
 * structure-derived entry and stop remain authoritative.
 */
export function enforceMinimumRRTarget({ pair, direction, entry, stopLoss, target, minRR = configuredIctMinRR() }) {
  const bull = direction === 'long' || direction === 'bullish' || direction === 'buy';
  const bear = direction === 'short' || direction === 'bearish' || direction === 'sell';
  const entryPrice = Number(entry);
  const stopPrice = Number(stopLoss);
  const rawTarget = Number(target);
  const floor = Number(minRR);

  if (!bull && !bear) return { ok: false, reason: 'Invalid trade direction for R:R target construction.' };
  if (![entryPrice, stopPrice, rawTarget, floor].every(Number.isFinite) || floor < ICT_MIN_RR) {
    return { ok: false, reason: 'Invalid price or minimum R:R input.' };
  }

  const geometryOK = bull
    ? stopPrice < entryPrice && rawTarget > entryPrice
    : stopPrice > entryPrice && rawTarget < entryPrice;
  if (!geometryOK) return { ok: false, reason: 'Invalid entry/stop/target geometry.' };

  const risk = Math.abs(entryPrice - stopPrice);
  if (risk <= 0) return { ok: false, reason: 'Degenerate stop distance.' };

  const minimumTarget = bull
    ? entryPrice + (risk * floor)
    : entryPrice - (risk * floor);
  const selectedTarget = bull
    ? Math.max(rawTarget, minimumTarget)
    : Math.min(rawTarget, minimumTarget);

  const tick = 10 ** (-pricePrecision(pair));
  let adjustedTarget = roundPrice(selectedTarget, pair);
  let reward = Math.abs(adjustedTarget - entryPrice);

  // Rounding can place the target one tick inside the floor. Step outward until
  // the executable, rounded price is truly at or above the minimum R:R.
  let safety = 0;
  while ((reward / risk) < (floor - 1e-9) && safety < 3) {
    adjustedTarget = roundPrice(adjustedTarget + (bull ? tick : -tick), pair);
    reward = Math.abs(adjustedTarget - entryPrice);
    safety += 1;
  }

  const rr = +(reward / risk).toFixed(2);
  if (rr < floor) return { ok: false, reason: `Could not construct minimum ${floor.toFixed(1)}R target after rounding.` };

  return {
    ok: true,
    target: adjustedTarget,
    rr,
    risk,
    reward,
    minimumTarget,
    rawTarget,
    adjusted: bull ? rawTarget < minimumTarget : rawTarget > minimumTarget,
  };
}
"""

OLD_SETUP_BLOCK = r"""  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(targetPool.price - entry);
  if (risk <= 0) return { ok: false, reason: 'Degenerate stop distance.' };
  const rr = +(reward / risk).toFixed(2);

  return {
    ok: true,
    entrySource,
    entry,
    stopLoss,
    target1: targetPool.price,
    target1Label: targetPool.label,
    target2: target2Pool ? target2Pool.price : null,
    target2Label: target2Pool ? target2Pool.label : null,
    rr,
    riskPips: toPips(risk, pair),
    rewardPips: toPips(reward, pair),
  };
"""

NEW_SETUP_BLOCK = r"""  const targetPolicy = enforceMinimumRRTarget({
    pair,
    direction: dir,
    entry,
    stopLoss,
    target: targetPool.price,
    minRR: configuredIctMinRR(),
  });
  if (!targetPolicy.ok) return targetPolicy;

  const {
    target: target1,
    rr,
    risk,
    reward,
    rawTarget: rawLiquidityTarget,
    adjusted: targetAdjustedToMinRR,
  } = targetPolicy;

  const target2Price = target2Pool ? Number(target2Pool.price) : null;
  const target2IsBeyondTarget1 = Number.isFinite(target2Price) && (
    bull ? target2Price > target1 : target2Price < target1
  );

  return {
    ok: true,
    entrySource,
    entry,
    stopLoss,
    target1,
    target1Label: targetAdjustedToMinRR
      ? `${targetPool.label} (extended to ${configuredIctMinRR().toFixed(1)}R minimum)`
      : targetPool.label,
    target2: target2IsBeyondTarget1 ? target2Price : null,
    target2Label: target2IsBeyondTarget1 ? target2Pool.label : null,
    rr,
    riskPips: toPips(risk, pair),
    rewardPips: toPips(reward, pair),
    rawLiquidityTarget,
    targetAdjustedToMinRR,
    minimumRR: configuredIctMinRR(),
  };
"""


def replace_one_of(text: str, old_values: list[str], new: str, label: str) -> str:
    if new in text:
        return text
    matches = [old for old in old_values if old in text]
    if len(matches) != 1:
        raise RuntimeError(f"ICT R:R floor marker missing/ambiguous: {label} ({len(matches)} matches)")
    return text.replace(matches[0], new, 1)


def main() -> None:
    text = ENGINE.read_text(encoding="utf-8")

    text = replace_one_of(
        text,
        ["import { getPipSize, toPips, roundPrice } from './pipMath.js';"],
        "import { getPipSize, pricePrecision, toPips, roundPrice } from './pipMath.js';",
        "pricePrecision import",
    )

    if "export function enforceMinimumRRTarget" not in text:
        match = re.search(r"(export function isIctEnabled\(\) \{[^\n]+\}\n)", text)
        if not match:
            raise RuntimeError("ICT R:R floor marker missing: isIctEnabled anchor")
        text = text[: match.end()] + "\n" + POLICY_BLOCK + "\n" + text[match.end() :]

    text = replace_one_of(
        text,
        [
            "    minRR: parseFloat(process.env.ICT_MIN_RR || '2.0'),",
            "    minRR: parseFloat(process.env.ICT_MIN_RR || '1.5'),",
            "    minRR: ICT_MIN_RR,",
        ],
        "    minRR: configuredIctMinRR(),",
        "execution config minimum R:R",
    )

    for old in [
        "const MIN_RR = parseFloat(process.env.ICT_MIN_RR || '2.0');\n\n",
        "const MIN_RR = parseFloat(process.env.ICT_MIN_RR || '1.5');\n\n",
        "const MIN_RR = ICT_MIN_RR;\n\n",
    ]:
        text = text.replace(old, "", 1)

    if NEW_SETUP_BLOCK not in text:
        if OLD_SETUP_BLOCK not in text:
            raise RuntimeError("ICT R:R floor marker missing: computeSetup risk/reward block")
        text = text.replace(OLD_SETUP_BLOCK, NEW_SETUP_BLOCK, 1)

    text = text.replace(
        "  void MIN_RR; void pendingSweepDir; // RR is enforced for auto-execution (executor), not display",
        "  void pendingSweepDir; // Minimum R:R is already constructed into setup.target1.",
        1,
    )

    required = [
        "pricePrecision, toPips, roundPrice",
        "export const ICT_MIN_RR = 1.5;",
        "parseFloat(process.env.ICT_MIN_RR || '1.5')",
        "minRR: configuredIctMinRR()",
        "export function enforceMinimumRRTarget",
        "const targetPolicy = enforceMinimumRRTarget({",
        "targetAdjustedToMinRR",
        "minimumRR: configuredIctMinRR()",
        "void pendingSweepDir; // Minimum R:R is already constructed into setup.target1.",
    ]
    missing = [marker for marker in required if marker not in text]
    forbidden = [
        "const MIN_RR =",
        "const reward = Math.abs(targetPool.price - entry);",
        "target1: targetPool.price,",
        "void MIN_RR;",
    ]
    remaining = [marker for marker in forbidden if marker in text]
    if missing or remaining:
        raise RuntimeError(
            "ICT R:R floor enforcement incomplete"
            + (f"; missing={missing}" if missing else "")
            + (f"; forbidden={remaining}" if remaining else "")
        )

    ENGINE.write_text(text, encoding="utf-8")
    print("ICT R:R floor enforced: low natural targets extend to at least 1.5R before qualification/execution")


if __name__ == "__main__":
    main()
