#!/usr/bin/env python3
"""
Complete Signal Stack V3 TP-confidence + post-fill execution patch.

Run from the Signal Stack repository root:
    python3 patch_v3_tp_confidence_execution.py

What it fixes:
  1. V3 entry execution uses TP-hit confidence (85% floor), not legacy entry-quality confidence.
  2. V3 open trades use live TP-hit confidence, not the legacy MTF confidence waterfall.
  3. A V3 entry score of 100 is never used as a floor after entry; reversal/invalidation can
     drive live TP confidence down and trigger exit review/auto-close logic.
  4. Actual broker fill R:R is recalculated from fill/SL/TP. If slippage makes it < 1.5R,
     the TP is repaired to the minimum geometric R:R through OANDA's dependent-order endpoint.
     If that repair fails, the newly-filled trade is immediately flattened.

The script is intentionally strict: it creates backups, applies idempotent edits, runs
`node --check`, runs focused tests, and rolls back all edited files if validation fails.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path.cwd()
SERVER = ROOT / "server"
STAMP = datetime.now().strftime("%Y%m%d_%H%M%S")
BACKUP_DIR = ROOT / f"backup_v3_tp_confidence_{STAMP}"

FILES = {
    "tp": SERVER / "v3TpConfidence.js",
    "quality": SERVER / "v3QualityConfirmation.js",
    "auto": SERVER / "v3AutoTrade.js",
    "trade": SERVER / "oandaTrade.js",
    "history": SERVER / "oandaTradeHistory.js",
    "reassessor": SERVER / "oandaActiveTradeReassessor.js",
    "monitor": SERVER / "oandaActiveTradeMonitor.js",
    "test": SERVER / "v3TpConfidence.test.js",
}

TP_MODULE = r'''/**
 * V3 TP-hit confidence model.
 *
 * Entry confidence answers one question only: "How likely is the attached TP to be hit
 * before the SL?" It is deliberately separate from V3 setup/entry quality.
 *
 * Live confidence starts from the stored entry TP confidence, but it has NO entry-score
 * floor. Reversal, invalidation, opposing flow, MTF conflict, volatility collapse and
 * proximity to SL can drive it all the way down after the position is open.
 */

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = finite(value);
    if (n !== null) return n;
  }
  return null;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function percent(value) {
  const n = finite(value);
  if (n === null) return null;
  return clamp(n >= 0 && n <= 1 ? n * 100 : n);
}

function normalizeDirection(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'buy') return 'long';
  if (v === 'sell') return 'short';
  return v === 'long' || v === 'short' ? v : null;
}

function extractV3(signal = {}) {
  return signal.v3 || signal.v3Eval || signal.v3Analysis || signal.metadata?.v3 || {};
}

function geometricRR({ direction, entry, stopLoss, takeProfit } = {}) {
  const d = normalizeDirection(direction);
  const e = finite(entry);
  const sl = finite(stopLoss);
  const tp = finite(takeProfit);
  if (!d || e === null || sl === null || tp === null) return null;
  const risk = d === 'long' ? e - sl : sl - e;
  const reward = d === 'long' ? tp - e : e - tp;
  if (risk <= 0 || reward <= 0) return null;
  return +(reward / risk).toFixed(4);
}

function alignedStructure(v3, direction) {
  const sign = direction === 'long' ? 'bullish' : direction === 'short' ? 'bearish' : null;
  const structure = v3?.structure || {};
  return Boolean(
    sign && (
      (structure.chochDetected === true && structure.choch?.direction === sign) ||
      (structure.bosDetected === true && structure.bos?.direction === sign) ||
      String(structure.structureTrend || '').toLowerCase() === sign
    )
  );
}

function sweepState(v3, direction) {
  const sign = direction === 'long' ? 'bullish' : direction === 'short' ? 'bearish' : null;
  const sweep = v3?.liquidity?.liquiditySweep || v3?.liquidity?.sweep || null;
  const detected = v3?.liquidity?.liquiditySweepDetected === true || v3?.liquidity?.sweepDetected === true;
  const pending = sweep?.pending === true || String(sweep?.subtype || '').toLowerCase() === 'pending_sweep';
  const aligned = !sweep?.direction || sweep.direction === sign;
  return { confirmed: Boolean(detected && aligned && !pending), pending: Boolean(detected && aligned && pending) };
}

export function isPureV3Signal(signal = {}) {
  return (
    signal?.source === 'v3_pure_auto_ai' ||
    signal?.selectedLogicType === 'v3_pure' ||
    String(signal?.strategy || '').toUpperCase() === 'V3' ||
    signal?.engine === 'v3'
  );
}

export function isPureV3TradeRecord(record = {}) {
  return (
    record?.entrySelectedLogicType === 'v3_pure' ||
    String(record?.entryStrategy || record?.strategy || '').toUpperCase() === 'V3' ||
    record?.source === 'v3_pure_auto_ai'
  );
}

export function computeV3EntryTpHitConfidence(signal = {}) {
  const explicit = percent(firstNumber(
    signal.tpHitConfidence,
    signal.entryTpHitConfidence,
    signal.tpProbability,
    signal.tpProb,
    signal.lifecycle?.tpHitConfidence,
    signal.lifecycle?.tpProbability,
    signal.v3?.tpHitConfidence,
    signal.v3?.tpProbability,
    signal.v3Eval?.tpHitConfidence,
    signal.v3Eval?.tpProbability,
  ));
  if (explicit !== null) return +explicit.toFixed(1);

  const v3 = extractV3(signal);
  const direction = normalizeDirection(signal.direction || v3.direction || v3.signal);
  const score = clamp(firstNumber(v3.score, signal.v3Score, signal.score, 0) ?? 0);
  const rr = firstNumber(
    geometricRR({
      direction,
      entry: signal.entry ?? signal.entryPrice ?? signal.currentPrice,
      stopLoss: signal.stopLoss ?? signal.sl ?? signal.lifecycle?.sl?.stopLossPrice,
      takeProfit: signal.takeProfit ?? signal.targetProfit ?? signal.tp ?? signal.lifecycle?.tp?.takeProfitPrice,
    }),
    signal.expectedRR,
    signal.rr,
    signal.riskReward,
    signal.riskRewardRatio,
  );

  const pdScore = firstNumber(v3?.premiumDiscount?.premiumDiscountScore, 0) ?? 0;
  const liquidityScore = firstNumber(v3?.liquidityIntent?.intentScore, v3?.liquidityIntent?.score, 0) ?? 0;
  const sweep = sweepState(v3, direction);
  const targetAccepted = v3?.targets?.accepted !== false && signal?.lifecycle?.tp?.allowed !== false;
  const earlyTrigger = signal.earlyTrigger === true || v3.earlyTrigger === true;

  let confidence = 45 + score * 0.35;
  if (v3.qualified === true) confidence += 6;
  if (earlyTrigger) confidence += 4;
  if (pdScore >= 0.72) confidence += 4;
  if (liquidityScore >= 0.65) confidence += 5;
  if (alignedStructure(v3, direction)) confidence += 4;
  if (sweep.confirmed) confidence += 3;
  if (sweep.pending) confidence -= 8;
  if (!targetAccepted) confidence = Math.min(confidence, 35);

  // A farther target is naturally harder to hit. This is a probability adjustment,
  // not an R:R rejection; the universal 1.5R geometry gate remains separate.
  if (rr !== null && rr > 1.5) confidence -= Math.min(10, (rr - 1.5) * 4);

  const spread = firstNumber(signal.spreadPips);
  const maxSpread = firstNumber(signal.maxSpreadPips, 3.5);
  if (spread !== null && maxSpread && spread > maxSpread * 0.75) confidence -= 4;

  return +clamp(confidence).toFixed(1);
}

export function computeLiveV3TpHitConfidence(context = {}) {
  const side = normalizeDirection(context.side || context.direction);
  const entryPrice = finite(context.entryPrice);
  const currentPrice = finite(context.currentPrice);
  const stopLoss = finite(context.stopLoss ?? context.currentSL ?? context.originalSL);
  const takeProfit = finite(context.takeProfit ?? context.currentTP ?? context.originalTP);

  const entryTpHitConfidence = percent(firstNumber(
    context.entryTpHitConfidence,
    context.historyRecord?.entryTpHitConfidence,
    context.historyRecord?.tpHitConfidence,
    context.tpHitConfidence,
    50,
  )) ?? 50;

  let confidence = entryTpHitConfidence;
  const adjustments = [];
  const apply = (label, delta) => {
    if (!Number.isFinite(delta) || delta === 0) return;
    confidence += delta;
    adjustments.push({ label, delta: +delta.toFixed(1) });
  };

  const riskDistance = (
    side && entryPrice !== null && stopLoss !== null
      ? Math.abs(entryPrice - stopLoss)
      : null
  );
  const profitDistance = (
    side && entryPrice !== null && currentPrice !== null
      ? (side === 'long' ? currentPrice - entryPrice : entryPrice - currentPrice)
      : null
  );
  const profitR = firstNumber(
    context.profitR,
    context.profitRMultiple,
    riskDistance && profitDistance !== null ? profitDistance / riskDistance : null,
  );

  const totalTargetDistance = (
    side && entryPrice !== null && takeProfit !== null
      ? Math.abs(takeProfit - entryPrice)
      : null
  );
  const rawProgress = firstNumber(
    context.tpProgress,
    totalTargetDistance && profitDistance !== null ? profitDistance / totalTargetDistance : null,
    0,
  ) ?? 0;
  const tpProgress = clamp(rawProgress, 0, 1);
  apply('progress toward TP', tpProgress * 12);

  if (profitR !== null) {
    if (profitR >= 0) apply('positive R progress', Math.min(8, profitR * 5));
    else apply('negative R progress', -Math.min(22, Math.abs(profitR) * 14));
  }

  const entryAlignment = firstNumber(context.entryAlignmentScore, context.entryMtfScore);
  const currentAlignment = firstNumber(context.currentAlignmentScore, context.currentMtfScore);
  if (entryAlignment !== null && currentAlignment !== null) {
    apply('alignment change', clamp((currentAlignment - entryAlignment) * 0.18, -14, 10));
  }

  if (context.flowMatchesDirection === true) apply('institutional flow aligned', 5);
  if (context.flowOpposes === true) apply('institutional flow opposes', -20);
  if (context.mtfConflict === true) apply('MTF conflict', -18);
  if (context.macroOpposes === true) apply('macro bias opposes', -18);
  if (context.m15TrendReversed === true) apply('M15 trend reversal', -30);
  if (context.volatilityCollapsed === true) apply('volatility collapse', -14);

  if (context.trendWeakeningDetected === true) {
    const severity = String(context.trendWeakeningSeverity || '').toLowerCase();
    apply('trend weakening', severity === 'high' ? -24 : -12);
  }

  const momentumStatus = String(context.momentumStatus || '').toLowerCase();
  if (momentumStatus.includes('reversal') || momentumStatus.includes('reversed')) {
    apply('momentum reversal', -32);
  } else if (momentumStatus.includes('decay')) {
    apply('momentum decay', -18);
  } else if (momentumStatus.includes('slowing')) {
    apply('momentum slowing', -9);
  }

  let hitTp = false;
  let hitSl = false;
  if (side && currentPrice !== null && takeProfit !== null) {
    hitTp = side === 'long' ? currentPrice >= takeProfit : currentPrice <= takeProfit;
  }
  if (side && currentPrice !== null && stopLoss !== null) {
    hitSl = side === 'long' ? currentPrice <= stopLoss : currentPrice >= stopLoss;
  }

  if (hitTp) confidence = 100;
  if (hitSl) confidence = 0;

  const invalidated = context.invalidationDetected === true || hitSl;
  if (invalidated) {
    confidence = Math.min(confidence, 5);
    adjustments.push({ label: 'trade invalidated', delta: 'cap_to_5' });
  }

  confidence = +clamp(confidence).toFixed(1);

  let state = 'ON_TRACK';
  let exitRecommendation = 'HOLD';
  if (hitTp) {
    state = 'TP_REACHED';
    exitRecommendation = 'TAKE_PROFIT';
  } else if (invalidated || confidence <= 20) {
    state = 'INVALIDATED';
    exitRecommendation = 'EXIT_NOW';
  } else if (confidence < 45) {
    state = 'AT_RISK';
    exitRecommendation = 'EXIT_REVIEW';
  } else if (confidence < 60) {
    state = 'WEAKENING';
    exitRecommendation = 'PROTECT_OR_REDUCE';
  }

  return {
    tpHitConfidence: confidence,
    entryTpHitConfidence: +entryTpHitConfidence.toFixed(1),
    tpProbability: +(confidence / 100).toFixed(3),
    slProbability: +(1 - confidence / 100).toFixed(3),
    state,
    exitRecommendation,
    invalidated,
    hitTp,
    hitSl,
    profitR: profitR === null ? null : +profitR.toFixed(3),
    tpProgress: +tpProgress.toFixed(3),
    adjustments,
    confidenceModel: 'v3_live_tp_hit',
  };
}

export function repriceV3TpHitConfidence({
  baseConfidence,
  originalRR,
  actualRR,
  rrPenaltyPerR = 4,
} = {}) {
  const base = percent(baseConfidence);
  const before = finite(originalRR);
  const after = finite(actualRR);
  const penalty = finite(rrPenaltyPerR);
  if (base === null || before === null || after === null || after <= 0) return 0;
  const adjusted = base - (after - before) * (penalty === null ? 4 : penalty);
  return +clamp(adjusted).toFixed(1);
}

export function computePostFillRiskReward(args = {}) {
  return geometricRR(args);
}

export function priceForMinimumRR({ direction, fillPrice, stopLoss, minRR = 1.5, priceDecimals = 5 } = {}) {
  const side = normalizeDirection(direction);
  const fill = finite(fillPrice);
  const sl = finite(stopLoss);
  const rr = finite(minRR);
  if (!side || fill === null || sl === null || rr === null || rr <= 0) return null;

  const risk = side === 'long' ? fill - sl : sl - fill;
  if (risk <= 0) return null;

  const tick = 10 ** (-Math.max(0, Number(priceDecimals) || 0));
  const raw = side === 'long' ? fill + risk * rr : fill - risk * rr;

  // Round one tick OUTWARD so decimal rounding cannot leave the repaired TP at 1.499xR.
  const ticks = raw / tick;
  const outward = side === 'long' ? Math.ceil(ticks - 1e-9) + 1 : Math.floor(ticks + 1e-9) - 1;
  return +(outward * tick).toFixed(Math.max(0, Number(priceDecimals) || 0));
}

export const _test = {
  clamp,
  percent,
  geometricRR,
  normalizeDirection,
};
'''

TEST_MODULE = r'''import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeV3EntryTpHitConfidence,
  computeLiveV3TpHitConfidence,
  computePostFillRiskReward,
  priceForMinimumRR,
  repriceV3TpHitConfidence,
  isPureV3TradeRecord,
} from './v3TpConfidence.js';

test('explicit TP confidence wins over legacy entry confidence', () => {
  const value = computeV3EntryTpHitConfidence({
    strategy: 'V3',
    confidence: 2,
    tpHitConfidence: 88,
  });
  assert.equal(value, 88);
});

test('live V3 confidence is not floored by a 100 entry score', () => {
  const live = computeLiveV3TpHitConfidence({
    side: 'long',
    entryPrice: 1.1000,
    currentPrice: 1.0992,
    stopLoss: 1.0990,
    takeProfit: 1.1020,
    entryTpHitConfidence: 100,
    entryAlignmentScore: 90,
    currentAlignmentScore: 35,
    flowOpposes: true,
    mtfConflict: true,
    m15TrendReversed: true,
    trendWeakeningDetected: true,
    trendWeakeningSeverity: 'high',
  });
  assert.ok(live.tpHitConfidence < 45, JSON.stringify(live));
  assert.notEqual(live.exitRecommendation, 'HOLD');
});

test('invalidation caps live TP confidence and requests exit', () => {
  const live = computeLiveV3TpHitConfidence({
    side: 'short',
    entryPrice: 1.3000,
    currentPrice: 1.3010,
    stopLoss: 1.3020,
    takeProfit: 1.2970,
    entryTpHitConfidence: 96,
    invalidationDetected: true,
  });
  assert.ok(live.tpHitConfidence <= 5);
  assert.equal(live.exitRecommendation, 'EXIT_NOW');
});

test('post-fill TP repair restores at least 1.5R', () => {
  const fillPrice = 1.41605;
  const stopLoss = 1.41516;
  const oldTp = 1.41726;
  const before = computePostFillRiskReward({ direction: 'long', entry: fillPrice, stopLoss, takeProfit: oldTp });
  assert.ok(before < 1.5);
  const repaired = priceForMinimumRR({ direction: 'long', fillPrice, stopLoss, minRR: 1.5, priceDecimals: 5 });
  const after = computePostFillRiskReward({ direction: 'long', entry: fillPrice, stopLoss, takeProfit: repaired });
  assert.ok(after >= 1.5, `${repaired} => ${after}`);
});

test('post-fill TP confidence is repriced from actual broker geometry', () => {
  assert.equal(repriceV3TpHitConfidence({ baseConfidence: 85, originalRR: 1.5, actualRR: 1.75 }), 84);
  assert.equal(repriceV3TpHitConfidence({ baseConfidence: 85, originalRR: 2.0, actualRR: 1.5 }), 87);
});

test('recognizes a V3 trade-history record', () => {
  assert.equal(isPureV3TradeRecord({ entrySelectedLogicType: 'v3_pure' }), true);
  assert.equal(isPureV3TradeRecord({ entryStrategy: 'V3' }), true);
  assert.equal(isPureV3TradeRecord({ entrySelectedLogicType: 'forex' }), false);
});
'''


def fail(message: str) -> None:
    raise RuntimeError(message)


def read(path: Path) -> str:
    if not path.exists():
        fail(f"Required file not found: {path}")
    return path.read_text(encoding="utf-8")


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text.rstrip() + "\n", encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    count = text.count(old)
    if count != 1:
        fail(f"{label}: expected one exact match, found {count}")
    return text.replace(old, new, 1)


def regex_once(
    text: str,
    pattern: str,
    replacement: str,
    label: str,
    flags: int = re.S,
    already_contains: str | None = None,
) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count == 0:
        if already_contains and already_contains in text:
            return text
        fail(f"{label}: target block not found")
    return updated


def ensure_import(text: str, import_line: str, anchor_pattern: str, label: str) -> str:
    if import_line in text:
        return text
    match = re.search(anchor_pattern, text, flags=re.M)
    if not match:
        fail(f"{label}: import anchor not found")
    return text[: match.end()] + "\n" + import_line + text[match.end():]


def backup(paths: list[Path]) -> None:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    for path in paths:
        if path.exists():
            destination = BACKUP_DIR / path.relative_to(ROOT)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, destination)


def restore(paths: list[Path]) -> None:
    for path in paths:
        source = BACKUP_DIR / path.relative_to(ROOT)
        if source.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, path)
        elif path.exists() and path in (FILES["tp"], FILES["test"]):
            path.unlink()


def patch_quality() -> None:
    path = FILES["quality"]
    text = read(path)
    text = ensure_import(
        text,
        "import { computeV3EntryTpHitConfidence } from './v3TpConfidence.js';",
        r"\*/\s*$",
        "v3QualityConfirmation import",
    )

    text = regex_once(
        text,
        r"  const score = firstNumber\(v3\.score, signal\.v3Score, signal\.score, 0\) \?\? 0;\n"
        r"  const confidence = firstNumber\(signal\.confidence, v3\.confidence, 0\) \?\? 0;\n"
        r"  const rr = getSignalRR\(signal\);",
        "  const score = firstNumber(v3.score, signal.v3Score, signal.score, 0) ?? 0;\n"
        "  const entryQualityConfidence = firstNumber(signal.entryQualityConfidence, signal.confidence, v3.confidence, 0) ?? 0;\n"
        "  const tpHitConfidence = computeV3EntryTpHitConfidence(signal);\n"
        "  const rr = getSignalRR(signal);",
        "quality confidence source",
        flags=0,
        already_contains="const tpHitConfidence = computeV3EntryTpHitConfidence(signal);",
    )

    text = regex_once(
        text,
        r"  const minScore = envNumber\('V3_QUALITY_SETUP_MIN_SCORE', 65\);\n"
        r"  const minConfidence = Math\.max\(85, envNumber\('V3_QUALITY_SETUP_MIN_CONFIDENCE', 85\)\);",
        "  const minScore = envNumber('V3_QUALITY_SETUP_MIN_SCORE', 65);\n"
        "  const minTpHitConfidence = Math.max(85, envNumber(\n"
        "    'V3_QUALITY_SETUP_MIN_TP_HIT_CONFIDENCE',\n"
        "    envNumber('V3_QUALITY_SETUP_MIN_CONFIDENCE', 85),\n"
        "  ));",
        "quality threshold",
        flags=0,
        already_contains="V3_QUALITY_SETUP_MIN_TP_HIT_CONFIDENCE",
    )

    text = text.replace(
        "  if (confidence < minConfidence) reasons.push(`confidence ${confidence} < ${minConfidence}`);",
        "  if (tpHitConfidence < minTpHitConfidence) reasons.push(`TP-hit confidence ${tpHitConfidence} < ${minTpHitConfidence}`);",
    )

    text = text.replace(
        "      confidence,\n      rr,\n      minScore,\n      minConfidence,",
        "      confidence: tpHitConfidence, // compatibility alias; this is TP-hit confidence for V3\n"
        "      tpHitConfidence,\n"
        "      entryQualityConfidence,\n"
        "      rr,\n"
        "      minScore,\n"
        "      minConfidence: minTpHitConfidence,\n"
        "      minTpHitConfidence,",
    )
    write(path, text)


def patch_auto() -> None:
    path = FILES["auto"]
    text = read(path)
    text = ensure_import(
        text,
        "import { computeV3EntryTpHitConfidence } from './v3TpConfidence.js';",
        r"^import \{ evaluateV3SetupStage, evaluateV3TriggerStage \} from './v3QualityConfirmation\.js';$",
        "v3AutoTrade import",
    )

    pattern = (
        r"    const legacyConfidence = envNum\(item\?\.confidence \?\? v3\?\.confidence, NaN\);\n"
        r"    const confidence = Number\.isFinite\(v3ExecutionConfidence\)\n"
        r"      \? Math\.max\(Number\.isFinite\(legacyConfidence\) \? legacyConfidence : 0, v3ExecutionConfidence\)\n"
        r"      : legacyConfidence;"
    )
    replacement = (
        "    const legacyConfidence = envNum(item?.confidence ?? v3?.confidence, NaN);\n"
        "    const entryQualityConfidence = Number.isFinite(v3ExecutionConfidence)\n"
        "      ? Math.max(Number.isFinite(legacyConfidence) ? legacyConfidence : 0, v3ExecutionConfidence)\n"
        "      : legacyConfidence;\n"
        "    const tpHitConfidence = computeV3EntryTpHitConfidence({\n"
        "      ...item,\n"
        "      ...v3,\n"
        "      confidence: entryQualityConfidence,\n"
        "      entryQualityConfidence,\n"
        "      v3,\n"
        "    });\n"
        "    // Downstream generic confidence fields remain as a compatibility alias,\n"
        "    // but for pure V3 they now mean TP-hit confidence, not legacy entry quality.\n"
        "    const confidence = tpHitConfidence;"
    )
    text = regex_once(
        text, pattern, replacement, "v3AutoTrade confidence block", flags=0,
        already_contains="const entryQualityConfidence = Number.isFinite(v3ExecutionConfidence)",
    )

    candidate_old = "      confidence,\n      expectedRR: rr,"
    candidate_new = (
        "      confidence,\n"
        "      tpHitConfidence,\n"
        "      entryQualityConfidence,\n"
        "      expectedRR: rr,"
    )
    if "      tpHitConfidence,\n      entryQualityConfidence," not in text:
        if candidate_old not in text:
            fail("v3AutoTrade candidate fields: target not found")
        text = text.replace(candidate_old, candidate_new, 1)

    text = text.replace(
        "        confidence: sig.confidence,\n        expectedRR:",
        "        confidence: res.tpHitConfidence ?? sig.tpHitConfidence ?? sig.confidence,\n"
        "        tpHitConfidence: res.tpHitConfidence ?? sig.tpHitConfidence ?? sig.confidence,\n"
        "        entryQualityConfidence: sig.entryQualityConfidence ?? null,\n"
        "        actualFillRR: res.actualFillRR ?? res.sizing?.riskReward ?? null,\n"
        "        postFillTpAdjusted: res.postFillTpAdjusted === true,\n"
        "        expectedRR:",
    )
    text = text.replace(
        "const confidence = Number(item?.confidence ?? item?.score ?? item?.v3?.score ?? 0);",
        "const confidence = Number(item?.tpHitConfidence ?? item?.confidence ?? item?.score ?? item?.v3?.score ?? 0);",
    )
    write(path, text)


def patch_trade() -> None:
    path = FILES["trade"]
    text = read(path)
    text = ensure_import(
        text,
        "import { computeV3EntryTpHitConfidence, computePostFillRiskReward, priceForMinimumRR, repriceV3TpHitConfidence } from './v3TpConfidence.js';",
        r"^import \{ evaluateV3FreshExecutionStage \} from './v3QualityConfirmation\.js';$",
        "oandaTrade import",
    )

    # Make high-edge logic V3-aware if it is enabled elsewhere in the file.
    text = regex_once(
        text,
        r"function highEdgeAutoAiGate\(signal = \{\}, sizing = null\) \{\n"
        r"  const reasons = \[\];\n\n"
        r"  const confidence = pickFirstNumber\(signal\.confidence, 0\) \?\? 0;",
        "function highEdgeAutoAiGate(signal = {}, sizing = null) {\n"
        "  const reasons = [];\n\n"
        "  const pureV3 = isPureV3ExecutionSignal(signal);\n"
        "  const confidence = pickFirstNumber(signal.tpHitConfidence, signal.confidence, 0) ?? 0;",
        "oandaTrade high-edge confidence",
        flags=0,
        already_contains="const pureV3 = isPureV3ExecutionSignal(signal);",
    )
    text = text.replace(
        "  if (alignment < AUTO_AI_MIN_ALIGNMENT_SCORE) {\n    reasons.push(`alignment ${alignment} < ${AUTO_AI_MIN_ALIGNMENT_SCORE}`);\n  }",
        "  if (!pureV3 && alignment < AUTO_AI_MIN_ALIGNMENT_SCORE) {\n"
        "    reasons.push(`alignment ${alignment} < ${AUTO_AI_MIN_ALIGNMENT_SCORE}`);\n"
        "  }",
        1,
    )

    # Add reusable pure-V3 detector before executeTrade.
    anchor = "// ─── Main execution function ──────────────────────────────────────────────────"
    helper = """function isPureV3ExecutionSignal(signal = {}) {
  return (
    signal?.source === 'v3_pure_auto_ai' ||
    signal?.selectedLogicType === 'v3_pure' ||
    String(signal?.strategy || '').toUpperCase() === 'V3' ||
    signal?.engine === 'v3'
  );
}

"""
    if "function isPureV3ExecutionSignal" not in text:
        text = replace_once(text, anchor, helper + anchor, "oandaTrade V3 detector")

    execute_old = """export async function executeTrade(signal, options = {}) {
  const { client, autoAi = false } = options;
  const { pair, direction, score, confidence, entry, stopLoss, takeProfit, spreadPips } = signal;
  const pureV3Execution =
    signal?.source === 'v3_pure_auto_ai' ||
    signal?.selectedLogicType === 'v3_pure' ||
    signal?.strategy === 'V3';
"""
    execute_new = """export async function executeTrade(signal, options = {}) {
  const { client, autoAi = false } = options;
  const {
    pair, direction, score, confidence: signalConfidence,
    entry, stopLoss, takeProfit, spreadPips,
  } = signal;
  const pureV3Execution = isPureV3ExecutionSignal(signal);
  const entryQualityConfidence = Number(
    signal.entryQualityConfidence ?? signalConfidence ?? signal.v3?.confidence ?? 0
  );
  const tpHitConfidence = pureV3Execution
    ? computeV3EntryTpHitConfidence(signal)
    : null;
  const confidence = pureV3Execution ? tpHitConfidence : Number(signalConfidence);

  if (pureV3Execution) {
    signal.entryQualityConfidence = Number.isFinite(entryQualityConfidence) ? entryQualityConfidence : null;
    signal.tpHitConfidence = tpHitConfidence;
    signal.tpProbability = +(tpHitConfidence / 100).toFixed(3);
    signal.slProbability = +(1 - signal.tpProbability).toFixed(3);
    // Generic confidence remains a compatibility alias only.
    signal.confidence = tpHitConfidence;
  }
"""
    text = replace_once(text, execute_old, execute_new, "oandaTrade execute header")
    text = text.replace(
        "  const priceDecimals = metals ? 2 : 5;",
        "  const priceDecimals = metals ? 2 : (pair.includes('JPY') ? 3 : 5);",
        1,
    )

    text = text.replace(
        "  console.log(`[TRADE]   Score: ${score}/20, Conf: ${confidence}%, Spread: ${spreadPips} pips`);",
        "  console.log(\n"
        "    `[TRADE]   Score: ${score}/20, ${pureV3Execution ? 'TP Hit Conf' : 'Conf'}: ${confidence}%, ` +\n"
        "    `Spread: ${spreadPips} pips`\n"
        "  );",
        1,
    )
    text = text.replace(
        "  // ── Guard 3: Confidence ───────────────────────────────────────────────────\n"
        "  if (confidence < MIN_CONFIDENCE) {\n"
        "    return blocked(`Confidence ${confidence}% < minimum ${MIN_CONFIDENCE}%`);\n"
        "  }",
        "  // ── Guard 3: Entry execution probability ─────────────────────────────────\n"
        "  const configuredV3TpFloor = Number(\n"
        "    process.env.V3_MIN_TP_HIT_CONFIDENCE || process.env.RISK_AUTO_EXECUTION_MIN_CONFIDENCE || 85\n"
        "  );\n"
        "  const executionConfidenceFloor = pureV3Execution\n"
        "    ? Math.max(85, Number.isFinite(configuredV3TpFloor) ? configuredV3TpFloor : 85)\n"
        "    : MIN_CONFIDENCE;\n"
        "  if (!Number.isFinite(confidence) || confidence < executionConfidenceFloor) {\n"
        "    return blocked(\n"
        "      `${pureV3Execution ? 'TP-hit confidence' : 'Confidence'} ${Number.isFinite(confidence) ? confidence : 'n/a'}% ` +\n"
        "      `< minimum ${executionConfidenceFloor}%`\n"
        "    );\n"
        "  }",
        1,
    )

    fill_old = """  // Fill confirmed — SL/TP are already attached atomically by OANDA.
  const fillInfo        = extractFillTx(orderFillTransaction);
  const tradeId         = fillInfo.tradeId;
  const fillPrice       = parseFloat(fillInfo.price || entry);
  const tradeMarginUsed = parseFloat(
    fillInfo.initialMarginRequired || fillInfo.marginRequired || 0
  );

  console.log(
    `[TRADE] ✓ FILLED + SL/TP attached atomically — tradeId=${tradeId}, ` +
    `price=${fillPrice}, marginRequired=$${tradeMarginUsed.toFixed(2)}`
  );

  executionLog.push(logEntry('ORDER_FILL', {
    transaction: fillInfo,
    tradeId,
    fillPrice,
    marginRequired: tradeMarginUsed,
    stopLoss: slPrice,
    takeProfit: tpPrice,
    atomicSlTp: true,
  }));

  lastTradeTime = Date.now();
  dailyTradeTimestamps.push(lastTradeTime);
  activeTrades.add(tradeKey);
"""
    fill_new = """  // Fill confirmed — SL/TP were attached atomically. Revalidate using the ACTUAL
  // broker fill because market slippage can change geometric R:R after submission.
  const fillInfo        = extractFillTx(orderFillTransaction);
  const tradeId         = fillInfo.tradeId;
  const fillPrice       = parseFloat(fillInfo.price || entry);
  const tradeMarginUsed = parseFloat(
    fillInfo.initialMarginRequired || fillInfo.marginRequired || 0
  );

  // Count and lock every confirmed broker fill immediately. A successful emergency
  // flatten removes only the active lock; the daily fill count remains accurate.
  lastTradeTime = Date.now();
  dailyTradeTimestamps.push(lastTradeTime);
  activeTrades.add(tradeKey);

  let effectiveTpPrice = tpPrice;
  let postFillTpAdjusted = false;
  let actualFillRR = computePostFillRiskReward({
    direction,
    entry: fillPrice,
    stopLoss: slPrice,
    takeProfit: effectiveTpPrice,
  });

  const flattenPostFillTrade = async (reason) => {
    const closePath = tradeId
      ? `/v3/accounts/${accountId}/trades/${tradeId}/close`
      : `/v3/accounts/${accountId}/positions/${pair}/close`;
    const closeBody = tradeId
      ? { units: 'ALL' }
      : (direction === 'long' ? { longUnits: 'ALL' } : { shortUnits: 'ALL' });
    const response = client
      ? await client.put(closePath, closeBody)
      : await oandaPut(closePath, closeBody);
    activeTrades.delete(tradeKey);
    return response;
  };

  if (!Number.isFinite(actualFillRR) || actualFillRR < MIN_EXECUTABLE_RR) {
    const repairedTp = priceForMinimumRR({
      direction,
      fillPrice,
      stopLoss: slPrice,
      minRR: MIN_EXECUTABLE_RR,
      priceDecimals,
    });

    try {
      if (!tradeId || !Number.isFinite(repairedTp)) {
        throw new Error('missing tradeId or valid repaired TP');
      }
      const dependentOrderPath = `/v3/accounts/${accountId}/trades/${tradeId}/orders`;
      const dependentOrderBody = {
        takeProfit: { price: repairedTp.toFixed(priceDecimals), timeInForce: 'GTC' },
      };
      if (client) await client.put(dependentOrderPath, dependentOrderBody);
      else await oandaPut(dependentOrderPath, dependentOrderBody);

      effectiveTpPrice = repairedTp;
      actualFillRR = computePostFillRiskReward({
        direction,
        entry: fillPrice,
        stopLoss: slPrice,
        takeProfit: effectiveTpPrice,
      });
      postFillTpAdjusted = true;
      executionLog.push(logEntry('POST_FILL_RR_REPAIRED', {
        fillPrice,
        stopLoss: slPrice,
        previousTakeProfit: tpPrice,
        repairedTakeProfit: effectiveTpPrice,
        actualFillRR,
        minimumRR: MIN_EXECUTABLE_RR,
      }));
    } catch (repairError) {
      let closedAfterFill = false;
      let closeError = null;
      try {
        await flattenPostFillTrade(repairError.message);
        closedAfterFill = true;
      } catch (err) {
        closeError = err?.message || String(err);
      }

      console.error(
        `[POST_FILL_RR] ${pair} ${direction} fill=${fillPrice} RR=${actualFillRR ?? 'n/a'} ` +
        `repair failed (${repairError.message}); closed=${closedAfterFill}`
      );
      return {
        success: false,
        blocked: false,
        executionState: 'POST_FILL_RR_REJECTED',
        reason:
          `Actual fill R:R ${Number.isFinite(actualFillRR) ? actualFillRR : 'n/a'} < ${MIN_EXECUTABLE_RR}; ` +
          `TP repair failed and the fill was ${closedAfterFill ? 'closed immediately' : 'NOT closed automatically'}.`,
        tradeId,
        fillPrice,
        actualFillRR,
        minimumRR: MIN_EXECUTABLE_RR,
        closedAfterFill,
        closeError,
        sizing,
        executionLog,
        oandaResponse,
      };
    }
  }

  // A rounded dependent-order price must still pass the universal hard floor.
  if (!Number.isFinite(actualFillRR) || actualFillRR < MIN_EXECUTABLE_RR) {
    let closedAfterFill = false;
    let closeError = null;
    try {
      await flattenPostFillTrade('repaired TP still below minimum RR');
      closedAfterFill = true;
    } catch (err) {
      closeError = err?.message || String(err);
    }
    return {
      success: false,
      blocked: false,
      executionState: 'POST_FILL_RR_REJECTED',
      reason: `Actual fill R:R remained ${actualFillRR ?? 'n/a'} < ${MIN_EXECUTABLE_RR} after repair.`,
      tradeId,
      fillPrice,
      actualFillRR,
      closedAfterFill,
      closeError,
      sizing,
      executionLog,
      oandaResponse,
    };
  }

  // Reprice V3 TP-hit confidence using actual broker geometry. When slippage makes
  // the attached target less probable, first try the nearest legal 1.5R TP. If the
  // position still cannot maintain the 85% TP-hit floor, flatten it immediately.
  let postFillTpHitConfidence = pureV3Execution
    ? repriceV3TpHitConfidence({
        baseConfidence: tpHitConfidence,
        originalRR: finalSizingRR,
        actualRR: actualFillRR,
      })
    : null;

  if (
    pureV3Execution &&
    (!Number.isFinite(postFillTpHitConfidence) || postFillTpHitConfidence < executionConfidenceFloor)
  ) {
    const minimumTp = priceForMinimumRR({
      direction,
      fillPrice,
      stopLoss: slPrice,
      minRR: MIN_EXECUTABLE_RR,
      priceDecimals,
    });

    // A farther-than-minimum TP may be pulled in, but never below the universal RR floor.
    if (
      Number.isFinite(minimumTp) &&
      Number.isFinite(actualFillRR) &&
      actualFillRR > MIN_EXECUTABLE_RR + 0.0001 &&
      minimumTp !== effectiveTpPrice
    ) {
      try {
        if (!tradeId) throw new Error('missing tradeId for TP-confidence repair');
        const dependentOrderPath = `/v3/accounts/${accountId}/trades/${tradeId}/orders`;
        const dependentOrderBody = {
          takeProfit: { price: minimumTp.toFixed(priceDecimals), timeInForce: 'GTC' },
        };
        if (client) await client.put(dependentOrderPath, dependentOrderBody);
        else await oandaPut(dependentOrderPath, dependentOrderBody);

        const previousTp = effectiveTpPrice;
        effectiveTpPrice = minimumTp;
        actualFillRR = computePostFillRiskReward({
          direction,
          entry: fillPrice,
          stopLoss: slPrice,
          takeProfit: effectiveTpPrice,
        });
        postFillTpAdjusted = true;
        postFillTpHitConfidence = repriceV3TpHitConfidence({
          baseConfidence: tpHitConfidence,
          originalRR: finalSizingRR,
          actualRR: actualFillRR,
        });
        executionLog.push(logEntry('POST_FILL_TP_CONFIDENCE_REPAIRED', {
          previousTakeProfit: previousTp,
          repairedTakeProfit: effectiveTpPrice,
          actualFillRR,
          postFillTpHitConfidence,
          minimumTpHitConfidence: executionConfidenceFloor,
        }));
      } catch (confidenceRepairError) {
        executionLog.push(logEntry('POST_FILL_TP_CONFIDENCE_REPAIR_FAILED', {
          error: confidenceRepairError?.message || String(confidenceRepairError),
        }));
      }
    }

    if (!Number.isFinite(postFillTpHitConfidence) || postFillTpHitConfidence < executionConfidenceFloor) {
      let closedAfterFill = false;
      let closeError = null;
      try {
        await flattenPostFillTrade('post-fill TP-hit confidence below execution floor');
        closedAfterFill = true;
      } catch (err) {
        closeError = err?.message || String(err);
      }
      return {
        success: false,
        blocked: false,
        executionState: 'POST_FILL_TP_CONFIDENCE_REJECTED',
        reason:
          `Post-fill TP-hit confidence ${Number.isFinite(postFillTpHitConfidence) ? postFillTpHitConfidence : 'n/a'}% ` +
          `< ${executionConfidenceFloor}%; fill was ${closedAfterFill ? 'closed immediately' : 'NOT closed automatically'}.`,
        tradeId,
        fillPrice,
        actualFillRR,
        tpHitConfidence: postFillTpHitConfidence,
        minimumTpHitConfidence: executionConfidenceFloor,
        closedAfterFill,
        closeError,
        sizing,
        executionLog,
        oandaResponse,
      };
    }
  }

  if (pureV3Execution) {
    signal.preFillTpHitConfidence = tpHitConfidence;
    signal.tpHitConfidence = postFillTpHitConfidence;
    signal.entryTpHitConfidence = postFillTpHitConfidence;
    signal.tpProbability = +(postFillTpHitConfidence / 100).toFixed(3);
    signal.slProbability = +(1 - signal.tpProbability).toFixed(3);
    signal.confidence = postFillTpHitConfidence;
  }

  // Make the persisted sizing/history reflect broker reality, not the pre-fill quote.
  const actualRiskPips = Math.abs(fillPrice - slPrice) / pipSize;
  const actualRewardPips = Math.abs(effectiveTpPrice - fillPrice) / pipSize;
  sizing.stopLoss = slPrice;
  sizing.takeProfit = effectiveTpPrice;
  sizing.stopLossPips = +actualRiskPips.toFixed(2);
  sizing.takeProfitPips = +actualRewardPips.toFixed(2);
  sizing.riskReward = +actualFillRR.toFixed(2);
  signal.originalSignalEntry = entry;
  signal.entry = fillPrice;
  signal.entryPrice = fillPrice;
  signal.stopLoss = slPrice;
  signal.takeProfit = effectiveTpPrice;
  signal.targetProfit = effectiveTpPrice;
  signal.actualFillRR = +actualFillRR.toFixed(2);
  signal.postFillTpAdjusted = postFillTpAdjusted;

  console.log(
    `[TRADE] ✓ FILLED + SL/TP attached — tradeId=${tradeId}, price=${fillPrice}, ` +
    `actualRR=${actualFillRR.toFixed(2)}, tpAdjusted=${postFillTpAdjusted}, ` +
    `marginRequired=$${tradeMarginUsed.toFixed(2)}`
  );

  executionLog.push(logEntry('ORDER_FILL', {
    transaction: fillInfo,
    tradeId,
    fillPrice,
    marginRequired: tradeMarginUsed,
    stopLoss: slPrice,
    takeProfit: effectiveTpPrice,
    actualFillRR,
    postFillTpAdjusted,
    atomicSlTp: true,
  }));
"""
    text = replace_once(text, fill_old, fill_new, "oandaTrade post-fill block")

    text = text.replace("    entry,\n    stopLoss: slPrice,\n    takeProfit: tpPrice,", "    entry: fillPrice,\n    stopLoss: slPrice,\n    takeProfit: effectiveTpPrice,", 1)

    text = text.replace(
        "    confidence,\n    scoreBreakdown:",
        "    confidence,\n"
        "    entryQualityConfidence: signal.entryQualityConfidence ?? null,\n"
        "    entryTpHitConfidence: signal.tpHitConfidence ?? null,\n"
        "    entryStrategy: signal.strategy ?? (signal.selectedLogicType === 'v3_pure' ? 'V3' : null),\n"
        "    actualFillRR: signal.actualFillRR ?? sizing?.riskReward ?? null,\n"
        "    scoreBreakdown:",
        1,
    )

    text = text.replace(
        "    riskReward:      sizing?.riskReward ?? signal.riskReward,",
        "    riskReward:      signal.actualFillRR ?? sizing?.riskReward ?? signal.riskReward,",
        1,
    )

    text = text.replace(
        "    isPaperTrading: getEnvironment() !== 'live',\n  };",
        "    isPaperTrading: getEnvironment() !== 'live',\n"
        "    tpHitConfidence: signal.tpHitConfidence ?? null,\n"
        "    entryQualityConfidence: signal.entryQualityConfidence ?? null,\n"
        "    actualFillRR: signal.actualFillRR ?? sizing?.riskReward ?? null,\n"
        "    postFillTpAdjusted: signal.postFillTpAdjusted === true,\n"
        "  };",
        1,
    )
    write(path, text)


def patch_history() -> None:
    path = FILES["history"]
    text = read(path)
    text = replace_once(
        text,
        "    confidence: trade.confidence,\n    scoreBreakdown:",
        "    confidence: trade.confidence,\n"
        "    entryQualityConfidence: trade.entryQualityConfidence ?? null,\n"
        "    entryTpHitConfidence: trade.entryTpHitConfidence ?? trade.tpHitConfidence ?? null,\n"
        "    entryStrategy: trade.entryStrategy ?? trade.strategy ?? null,\n"
        "    actualFillRR: trade.actualFillRR ?? trade.riskReward ?? null,\n"
        "    scoreBreakdown:",
        "oandaTradeHistory confidence metadata",
    )
    write(path, text)


def patch_reassessor() -> None:
    path = FILES["reassessor"]
    text = read(path)
    text = ensure_import(
        text,
        "import { computeLiveV3TpHitConfidence, isPureV3TradeRecord } from './v3TpConfidence.js';",
        r"^import \{ analyzeTradeLifecycle \} from './oandaTradeLifecycleEngine\.js';$",
        "reassessor import",
    )

    text = text.replace(
        "  const currentConfidence = computeConfidenceScore({",
        "  const legacyCurrentConfidence = computeConfidenceScore({",
        1,
    )

    text = replace_once(
        text,
        "    originalRecommendedSL:     historyRecord.originalRecommendedSL,\n  } : {};",
        "    originalRecommendedSL:     historyRecord.originalRecommendedSL,\n"
        "    entryTpHitConfidence:      historyRecord.entryTpHitConfidence,\n"
        "    entryQualityConfidence:    historyRecord.entryQualityConfidence,\n"
        "    entryStrategy:             historyRecord.entryStrategy,\n"
        "  } : {};\n"
        "  const pureV3Trade = isPureV3TradeRecord(historyRecord || entryContext);",
        "reassessor entry context",
    )

    lifecycle_context_anchor = (
        "  const marketStateAllowed = profile.allowedMarketStates?.includes(marketState.marketState) ?? true;\n"
    )
    live_block = lifecycle_context_anchor + """

  // Pure V3 positions must never be re-scored by the legacy entry-confidence model.
  // Entry V3 score is only the starting probability; there is deliberately no floor.
  const liveV3Confidence = pureV3Trade
    ? computeLiveV3TpHitConfidence({
        side,
        entryPrice,
        currentPrice,
        stopLoss: currentSL ?? originalSL,
        takeProfit: currentTP ?? originalTP,
        entryTpHitConfidence: entryContext.entryTpHitConfidence,
        historyRecord,
        profitR,
        tpProgress,
        entryAlignmentScore: entryContext.entryMtfAlignmentScore,
        currentAlignmentScore: alignment.timeframeAlignmentScore,
        entryMtfScore: entryContext.entryMtfAlignmentScore,
        currentMtfScore: mtfAuthority.multiTimeframeAlignmentScore,
        mtfConflict: mtfAuthority.conflict,
        flowOpposes,
        flowMatchesDirection,
        m15TrendReversed,
        volatilityCollapsed: volatilityCollapse.volatilityCollapsed,
        invalidationDetected: invalidation.invalidationDetected,
        trendWeakeningDetected: trendWeakening.trendWeakeningDetected,
        trendWeakeningSeverity: trendWeakening.trendWeakeningSeverity,
      })
    : null;
  const currentConfidence = liveV3Confidence?.tpHitConfidence ?? legacyCurrentConfidence;

  if (
    pureV3Trade &&
    liveV3Confidence &&
    (liveV3Confidence.exitRecommendation === 'EXIT_NOW' || liveV3Confidence.exitRecommendation === 'EXIT_REVIEW') &&
    recommendedAction === 'HOLD'
  ) {
    recommendedAction = 'EXIT_REVIEW';
    managementReasons.push(
      `V3 live TP-hit confidence fell to ${liveV3Confidence.tpHitConfidence}% ` +
      `(${liveV3Confidence.state}); entry V3 score is not used as a post-entry floor.`
    );
  }
"""
    text = replace_once(text, lifecycle_context_anchor, live_block, "reassessor live V3 confidence")

    text = text.replace(
        "    currentConfidence,\n    minutesElapsed,",
        "    currentConfidence,\n"
        "    confidenceModel: pureV3Trade ? 'v3_live_tp_hit' : 'legacy_mtf',\n"
        "    entryTpHitConfidence: entryContext.entryTpHitConfidence ?? null,\n"
        "    entryQualityConfidence: entryContext.entryQualityConfidence ?? null,\n"
        "    liveTpConfidence: liveV3Confidence,\n"
        "    minutesElapsed,",
        1,
    )
    write(path, text)


def patch_monitor() -> None:
    path = FILES["monitor"]
    text = read(path)
    text = ensure_import(
        text,
        "import { findTradeByBrokerOrderId } from './oandaTradeHistory.js';",
        r"^import \{\n  computeHoldWindow, computeTradeProbabilities, classifyTradeState,\n\} from './oandaTradeLifecycle\.js';$",
        "monitor history import",
    )
    text = ensure_import(
        text,
        "import { computeLiveV3TpHitConfidence, isPureV3TradeRecord } from './v3TpConfidence.js';",
        r"^import \{ findTradeByBrokerOrderId \} from './oandaTradeHistory\.js';$",
        "monitor V3 import",
    )

    text = text.replace(
        "  const currentConfidence = computeConfidenceScore({",
        "  const legacyCurrentConfidence = computeConfidenceScore({",
        1,
    )

    classification_anchor = """  const classification = classifyTradeState({
    pair, side,
    entryPrice, currentPrice,
    stopLoss: stopLoss ?? (side === 'long' ? entryPrice * 0.99 : entryPrice * 1.01),
    takeProfit: takeProfit ?? (side === 'long' ? entryPrice * 1.01 : entryPrice * 0.99),
    currentWaterfall: { macro, structure, momentum, alignment },
    minutesElapsed,
    holdWindow: updatedHoldWindow,
  });
"""
    classification_new = classification_anchor + """

  const historyRecord = findTradeByBrokerOrderId(String(oandaTrade.id));
  const pureV3Trade = isPureV3TradeRecord(historyRecord || {});
  const tradeSign = side === 'long' ? 'bullish' : 'bearish';
  const macroBias = String(macro?.macroBias || macro?.h4Trend || '').toLowerCase();
  const macroOpposes = Boolean(macroBias && macroBias !== 'neutral' && !macroBias.includes(tradeSign));
  const m15Trend = String(momentum?.m15Trend || momentum?.trend || '').toLowerCase();
  const m15TrendReversed =
    (side === 'long' && m15Trend === 'bearish') ||
    (side === 'short' && m15Trend === 'bullish');

  const liveV3Confidence = pureV3Trade
    ? computeLiveV3TpHitConfidence({
        side,
        entryPrice,
        currentPrice,
        stopLoss,
        takeProfit,
        entryTpHitConfidence: historyRecord?.entryTpHitConfidence,
        historyRecord,
        tpProgress: classification.tpProgress,
        entryAlignmentScore: historyRecord?.entryMtfAlignmentScore,
        currentAlignmentScore: alignment.timeframeAlignmentScore,
        mtfConflict: alignment.conflicting === true || alignment.conflict === true,
        macroOpposes,
        m15TrendReversed,
      })
    : null;
  const currentConfidence = liveV3Confidence?.tpHitConfidence ?? legacyCurrentConfidence;
"""
    text = replace_once(text, classification_anchor, classification_new, "monitor live V3 confidence")

    text = text.replace(
        "    tradeState: classification.tradeState,\n"
        "    exitRecommendation: classification.exitRecommendation,\n"
        "    exitReason: classification.exitReason,",
        "    tradeState: pureV3Trade ? liveV3Confidence.state : classification.tradeState,\n"
        "    exitRecommendation: pureV3Trade ? liveV3Confidence.exitRecommendation : classification.exitRecommendation,\n"
        "    exitReason: pureV3Trade\n"
        "      ? `V3 live TP-hit confidence ${liveV3Confidence.tpHitConfidence}% (${liveV3Confidence.state})`\n"
        "      : classification.exitReason,",
        1,
    )
    text = text.replace(
        "    tpProbability: probs.tpProbability,\n    slProbability: probs.slProbability,",
        "    tpProbability: pureV3Trade ? liveV3Confidence.tpProbability : probs.tpProbability,\n"
        "    slProbability: pureV3Trade ? liveV3Confidence.slProbability : probs.slProbability,\n"
        "    confidenceModel: pureV3Trade ? 'v3_live_tp_hit' : 'legacy_mtf',\n"
        "    entryTpHitConfidence: historyRecord?.entryTpHitConfidence ?? null,\n"
        "    entryQualityConfidence: historyRecord?.entryQualityConfidence ?? null,\n"
        "    liveTpConfidence: liveV3Confidence,",
        1,
    )
    write(path, text)


def validate(paths: list[Path]) -> None:
    node = shutil.which("node")
    if not node:
        print("WARNING: node was not found; Python patch completed but JS validation was skipped.")
        return

    for path in paths:
        if path.suffix == ".js":
            subprocess.run([node, "--check", str(path)], cwd=ROOT, check=True)

    subprocess.run(
        [node, "--test", str(FILES["test"])],
        cwd=ROOT,
        check=True,
    )


def main() -> int:
    if not SERVER.is_dir() or not (ROOT / "package.json").exists():
        print("ERROR: run this script from the Signal Stack repository root.", file=sys.stderr)
        return 2

    required_existing = [
        FILES["quality"], FILES["auto"], FILES["trade"], FILES["history"],
        FILES["reassessor"], FILES["monitor"],
    ]
    for path in required_existing:
        if not path.exists():
            print(f"ERROR: missing required file: {path}", file=sys.stderr)
            return 2

    touched = list(FILES.values())
    backup(touched)

    try:
        write(FILES["tp"], TP_MODULE)
        write(FILES["test"], TEST_MODULE)
        patch_quality()
        patch_auto()
        patch_trade()
        patch_history()
        patch_reassessor()
        patch_monitor()
        validate(touched)
    except Exception as exc:
        restore(touched)
        print(f"\nPATCH FAILED — all edited files were restored from {BACKUP_DIR}", file=sys.stderr)
        print(f"Reason: {exc}", file=sys.stderr)
        return 1

    print("\nPATCH COMPLETE")
    print(f"Backup: {BACKUP_DIR}")
    print("Changed:")
    for path in touched:
        print(f"  - {path.relative_to(ROOT)}")
    print("\nRecommended verification:")
    print("  git diff -- server/v3TpConfidence.js server/v3QualityConfirmation.js server/v3AutoTrade.js \\")
    print("    server/oandaTrade.js server/oandaTradeHistory.js server/oandaActiveTradeReassessor.js \\")
    print("    server/oandaActiveTradeMonitor.js server/v3TpConfidence.test.js")
    print("  node --test server/v3TpConfidence.test.js")
    print("  npm run build")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
