/**
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

/**
 * Compatibility evaluator for V3 Stage-3 execution confirmation.
 *
 * This function intentionally does not replace either:
 *   - computeV3EntryTpHitConfidence: entry TP probability
 *   - computeLiveV3TpHitConfidence: open-position TP probability
 *
 * It evaluates whether the TP is still sufficiently probable immediately
 * before order submission.
 */
export function computeV3TpHitConfidence(context = {}) {
  const mode = String(context.mode || 'entry').toLowerCase();

  const configuredMinimum = Number(
    process.env.V3_MIN_TP_HIT_CONFIDENCE ??
    process.env.V3_QUALITY_SETUP_MIN_TP_HIT_CONFIDENCE ??
    85
  );

  const minimumEntryConfidence = Math.max(
    85,
    Number.isFinite(configuredMinimum) ? configuredMinimum : 85,
  );

  if (mode === 'live') {
    const live = computeLiveV3TpHitConfidence({
      ...context,
      side: context.side ?? context.direction,
    });

    return {
      ...live,
      minimumEntryConfidence,
      allowed: live.tpHitConfidence >= minimumEntryConfidence,
      warnings: Array.isArray(live.adjustments)
        ? live.adjustments
            .filter((item) => Number(item?.delta) < 0)
            .map((item) => String(item?.label || 'adverse live condition'))
        : [],
      method: live.confidenceModel || 'v3_live_tp_hit',
      checkedAt: new Date().toISOString(),
    };
  }

  let score = 52;
  const warnings = [];

  if (context.stage2Allowed === true) {
    score += 14;
  } else {
    score -= 45;
    warnings.push('fresh V3 trigger is invalid');
  }

  const primaryTriggerCount = finite(context.primaryTriggerCount) ?? 0;
  const supportCount = finite(context.supportCount) ?? 0;

  score += Math.min(3, Math.max(0, primaryTriggerCount)) * 5;
  score += Math.min(4, Math.max(0, supportCount)) * 3;

  const liveRR = firstNumber(
    context.liveRR,
    geometricRR({
      direction: context.direction,
      entry: context.currentPrice ?? context.entryPrice,
      stopLoss: context.stopLoss,
      takeProfit: context.takeProfit,
    }),
  );

  if (liveRR === null || liveRR < 1.5) {
    score -= 60;
    warnings.push(`R:R ${liveRR ?? 'n/a'} below 1.5`);
  } else if (liveRR >= 3) {
    score += 10;
  } else if (liveRR >= 2) {
    score += 8;
  } else {
    score += 5;
  }

  if (context.confirmedSweep === true) score += 3;
  if (context.alignedChoch === true) score += 3;
  if (context.alignedBos === true) score += 3;
  if (context.compressionExpansion === true) score += 3;

  const spread = finite(context.currentSpreadPips);
  const maxSpread = finite(context.maxSpreadPips);

  if (spread !== null && maxSpread !== null && maxSpread > 0) {
    const spreadRatio = spread / maxSpread;

    if (spreadRatio <= 0.35) {
      score += 4;
    } else if (spreadRatio <= 0.70) {
      score += 2;
    } else if (spreadRatio > 1) {
      score -= 25;
      warnings.push('spread exceeds maximum');
    }
  }

  const driftAtr = finite(context.driftAtr);
  const maximumDriftAtr = finite(context.maxPriceDriftAtr) ?? 0.15;

  if (driftAtr !== null) {
    if (driftAtr <= 0.05) {
      score += 5;
    } else if (driftAtr <= maximumDriftAtr) {
      score += 2;
    } else {
      score -= 18;
      warnings.push('price drift exceeds maximum');
    }
  }

  if (context.firstTargetReached === true) {
    score = 0;
    warnings.push('first target was already reached');
  }

  if (context.structureOpposes === true) {
    score -= 30;
    warnings.push('structure opposes the trade');
  }

  if (context.newsBlocked === true) {
    score -= 60;
    warnings.push('news block is active');
  }

  score = Math.round(clamp(score));

  return {
    tpHitConfidence: score,
    minimumEntryConfidence,
    allowed: score >= minimumEntryConfidence,
    warnings,
    method: 'v3_stage3_tp_hit_confidence',
    checkedAt: new Date().toISOString(),
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
