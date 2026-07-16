import { computeV3EntryTpHitConfidence } from './v3TpConfidence.js';
import { evaluatePrimaryTimeframeAlignment } from './primaryTimeframeAlignment.js';
import { evaluateStage2EntryContract } from './v3EntryContract.js';

/**
 * Two-stage V3 quality confirmation.
 *
 * Stage 1: Is this a valid setup worth watching?
 * Stage 2: Is there a fresh, direction-specific execution trigger?
 *
 * This module is pure. It does not call OANDA and does not place orders.
 */

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = numberOrNull(value);
    if (n !== null) return n;
  }
  return null;
}

function normalizeDirection(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'buy') return 'long';
  if (v === 'sell') return 'short';
  return v === 'long' || v === 'short' ? v : null;
}

function directionSign(direction) {
  return direction === 'long' ? 'bullish' : direction === 'short' ? 'bearish' : null;
}

function extractV3(signal = {}) {
  return signal.v3 || signal.v3Eval || signal.v3Analysis || signal.metadata?.v3 || signal;
}

function pipSizeFor(pair = '') {
  if (String(pair).includes('JPY')) return 0.01;
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return 0.01;
  return 0.0001;
}

function computePriceRR({ direction, entry, stopLoss, takeProfit } = {}) {
  const d = normalizeDirection(direction);
  const e = numberOrNull(entry);
  const sl = numberOrNull(stopLoss);
  const tp = numberOrNull(takeProfit);
  if (!d || e === null || sl === null || tp === null) return null;

  const risk = d === 'long' ? e - sl : sl - e;
  const reward = d === 'long' ? tp - e : e - tp;
  if (risk <= 0 || reward <= 0) return null;
  return +(reward / risk).toFixed(3);
}

function getSignalRR(signal = {}) {
  return firstNumber(
    computePriceRR({
      direction: signal.direction,
      entry: signal.entry ?? signal.entryPrice ?? signal.currentPrice,
      stopLoss: signal.stopLoss ?? signal.sl ?? signal.lifecycle?.sl?.stopLossPrice,
      takeProfit: signal.takeProfit ?? signal.targetProfit ?? signal.tp ?? signal.lifecycle?.tp?.takeProfitPrice,
    }),
    signal.expectedRR,
    signal.rr,
    signal.riskReward,
    signal.riskRewardRatio,
  );
}

function alignedStructureBreak(v3, direction) {
  const sign = directionSign(direction);
  const structure = v3?.structure || {};
  const chochAligned =
    structure.chochDetected === true &&
    structure.choch?.direction === sign;
  const bosAligned =
    structure.bosDetected === true &&
    structure.bos?.direction === sign;
  return { chochAligned, bosAligned, any: chochAligned || bosAligned };
}

function structureOpposes(v3, direction) {
  const sign = directionSign(direction);
  const trend = String(v3?.structure?.structureTrend || '').toLowerCase();
  if (!sign || !trend || trend === 'ranging') return false;
  return trend !== sign;
}

function confirmedAlignedSweep(v3, direction) {
  const sign = directionSign(direction);
  const liquidity = v3?.liquidity || {};
  const sweep = liquidity.liquiditySweep || null;
  const detected = liquidity.liquiditySweepDetected === true && sweep;
  if (!detected) return { confirmed: false, pending: false, sweep: null };

  const pending =
    sweep.pending === true ||
    String(sweep.subtype || '').toLowerCase() === 'pending_sweep';
  const aligned = sweep.direction === sign;

  return {
    confirmed: Boolean(aligned && !pending),
    pending: Boolean(aligned && pending),
    sweep,
  };
}

function confirmedNativeRetest(signal, direction) {
  const sign = directionSign(direction);
  const timing = signal?.entryTiming || {};
  const retest = timing?.retest || null;
  const timingStatus = String(timing?.status || '').toLowerCase();
  const aligned = !retest?.direction || retest.direction === sign;
  const confirmed =
    timing?.retestDetected === true &&
    timingStatus === 'valid_entry' &&
    aligned;

  return { confirmed, retest };
}

function favorablePremiumDiscount(v3, direction) {
  const pd = v3?.premiumDiscount || {};
  const state = String(pd.premiumDiscountState || '').toLowerCase();
  const score = firstNumber(pd.premiumDiscountScore, 0) ?? 0;
  const favorable =
    (direction === 'long' && state === 'discount') ||
    (direction === 'short' && state === 'premium') ||
    state === 'equilibrium';
  return { favorable: favorable || score >= 0.72, state, score };
}

function alignedFlowSupport(signal, direction) {
  if (confirmedNativeRetest(signal, direction).confirmed) return true;

  const sign = directionSign(direction);
  const signals = Array.isArray(signal?.institutionalFlow?.signals)
    ? signal.institutionalFlow.signals
    : [];

  return signals.some((item) => {
    const type = String(item?.type || '').toLowerCase();
    const subtype = String(item?.subtype || '').toLowerCase();
    const isSupportType =
      type === 'imbalance' ||
      type === 'retest' ||
      subtype.includes('retest') ||
      subtype.includes('fvg');
    return isSupportType && (!item?.direction || item.direction === sign);
  });
}

function alignedSessionNarrative(v3, direction) {
  const sign = directionSign(direction);
  const narrative = v3?.sessionNarrative || {};
  const bias = String(narrative.sessionBias || v3?.session?.sessionBias || '').toLowerCase();
  return bias === sign;
}

function alignedDisplacementProxy(signal, direction) {
  const sign = directionSign(direction);
  const momentum = signal?.momentum || {};
  const candle = signal?.candleStrength || {};
  const executionDirection = normalizeDirection(momentum.executionSignal);
  const executionConfidence = firstNumber(momentum.executionConfidence, 0) ?? 0;
  const classification = String(candle.classification || '').toLowerCase();
  const candleScore = firstNumber(candle.candleStrengthScore, 0) ?? 0;

  const momentumAligned = executionDirection === direction && executionConfidence >= 68;
  const candleAligned =
    candleScore >= 65 &&
    (
      classification.includes(sign) ||
      classification.includes('strong') ||
      classification.includes('impulse') ||
      classification.includes('displacement')
    );

  return momentumAligned || candleAligned;
}

function alignedLiquidityIntent(v3, direction) {
  const sign = directionSign(direction);
  const intent = v3?.liquidityIntent || {};
  const bias = String(intent.liquidityBias || '').toLowerCase();
  const score = firstNumber(intent.intentScore, intent.score, 0) ?? 0;
  return score >= 0.65 && (!bias || bias === sign);
}

export function evaluateV3SetupStage(signal = {}) {
  const v3 = extractV3(signal);
  const direction = normalizeDirection(signal.direction || v3.direction || v3.signal);
  const pair = signal.pair || v3.pair || null;
  const alignment = evaluatePrimaryTimeframeAlignment(v3, direction);
  const score = firstNumber(v3.score, signal.v3Score, signal.score, 0) ?? 0;
  const entryQualityConfidence = firstNumber(signal.entryQualityConfidence, signal.confidence, v3.confidence, 0) ?? 0;
  const tpHitConfidence = computeV3EntryTpHitConfidence(signal);
  const rr = getSignalRR(signal);

  const minScore = envNumber('V3_QUALITY_SETUP_MIN_SCORE', 62);
  const minRR = envNumber('FOREX_MIN_EXECUTABLE_RR', 1.5);
  const maxSpread = pair === 'XAU_USD' || pair === 'XAG_USD'
    ? envNumber('METALS_MAX_SPREAD_PIPS', 50)
    : envNumber('FOREX_MAX_SPREAD_PIPS', 3.5);

  const spread = firstNumber(signal.spreadPips);
  const targetsAccepted = v3?.targets?.accepted !== false && signal?.lifecycle?.tp?.allowed !== false;
  const newsBlocked =
    signal?.newsRisk?.blocked === true ||
    v3?.newsRisk?.blocked === true;

  const breaks = alignedStructureBreak(v3, direction);
  // Internal V3 structure opposition is diagnostic only for now. The authoritative
  // directional gate is the native Daily/H4/M15 aggregate alignment score.
  const opposingStructure = structureOpposes(v3, direction) && !breaks.chochAligned;

  const reasons = [];
  if (!pair) reasons.push('missing pair');
  if (!direction) reasons.push('missing V3 direction');
  if (!alignment.passed) reasons.push(alignment.reason);
  if (score < minScore) reasons.push(`V3 score ${score} < ${minScore}`);
  if (!Number.isFinite(rr) || rr < minRR) reasons.push(`geometric R:R ${rr ?? 'n/a'} < ${minRR}`);
  if (!targetsAccepted) reasons.push('remaining opportunity rejected');
  if (newsBlocked) reasons.push('news block active');
  if (spread !== null && spread > maxSpread) reasons.push(`spread ${spread} > ${maxSpread}`);

  return {
    stage: 1,
    allowed: reasons.length === 0,
    state: reasons.length === 0 ? 'watch' : 'blocked',
    reasons,
    metrics: {
      pair,
      direction,
      alignment,
      score,
      confidence: tpHitConfidence,
      tpHitConfidence,
      entryQualityConfidence,
      rr,
      minScore,
      minConfidence: null,
      minTpHitConfidence: null,
      tpConfidencePolicy: 'diagnostic_only',
      minRR,
      spread,
      maxSpread,
      targetsAccepted,
      newsBlocked,
      opposingStructure,
      opposingStructurePolicy: 'diagnostic_only',
      alignedChoch: breaks.chochAligned,
      confirmedRetest: confirmedNativeRetest(signal, direction).confirmed,
    },
    checkedAt: new Date().toISOString(),
  };
}

export function evaluateV3TriggerStage(signal = {}) {
  const v3 = extractV3(signal);
  const direction = normalizeDirection(signal.direction || v3.direction || v3.signal);
  const entryContract = evaluateStage2EntryContract(signal);
  const sweep = confirmedAlignedSweep(v3, direction);
  const retest = confirmedNativeRetest(signal, direction);
  const breaks = alignedStructureBreak(v3, direction);
  const volatilityState = String(v3?.volatility?.volatilityState || '').toLowerCase();

  // The volatility engine labels "expanding" only for the compression-to-expansion
  // transition. "compressed" by itself is watch-only and cannot trigger an order.
  const compressionExpansion =
    volatilityState === 'expanding' &&
    (
      v3?.volatility?.compressionDetected === true ||
      v3?.volatility?.expansionDetected === true
    );

  const primaryTriggers = [];
  if (retest.confirmed) primaryTriggers.push('confirmed_retest');
  if (sweep.confirmed) primaryTriggers.push('confirmed_liquidity_sweep');
  if (breaks.chochAligned) primaryTriggers.push('fresh_aligned_choch');
  if (breaks.bosAligned) primaryTriggers.push('fresh_aligned_bos');
  if (compressionExpansion) primaryTriggers.push('compression_to_expansion');

  const supports = [];
  const pd = favorablePremiumDiscount(v3, direction);
  if (pd.favorable) supports.push('favorable_premium_discount');
  if (alignedFlowSupport(signal, direction)) supports.push('fvg_or_retest');
  if (alignedSessionNarrative(v3, direction)) supports.push('session_narrative_aligned');
  if (alignedDisplacementProxy(signal, direction)) supports.push('directional_displacement');
  if (alignedLiquidityIntent(v3, direction)) supports.push('liquidity_intent_aligned');

  const minSupports = envNumber('V3_QUALITY_TRIGGER_MIN_SUPPORTS', 1);
  const reasons = [...entryContract.reasons];

  if (!direction) reasons.push('missing direction');
  if (sweep.pending) reasons.push('liquidity sweep is pending; close-back-inside confirmation is missing');
  if (primaryTriggers.length === 0) {
    reasons.push('no fresh primary trigger: confirmed retest/sweep, aligned BOS/CHoCH, or compression-to-expansion');
  }
  if (supports.length < minSupports) {
    reasons.push(`supporting confirmations ${supports.length} < ${minSupports}`);
  }
  if (volatilityState === 'expanded' && !sweep.confirmed && !retest.confirmed) {
    reasons.push('volatility is already expanded without a fresh confirmed retest or sweep');
  }

  return {
    stage: 2,
    allowed: reasons.length === 0,
    state: reasons.length === 0 ? 'ready' : (sweep.pending || primaryTriggers.length === 0 ? 'watch' : 'blocked'),
    reasons,
    primaryTriggers,
    supports,
    metrics: {
      direction,
      alignment: entryContract.alignment,
      entryTiming: entryContract.entryTiming,
      sweepBlock: entryContract.sweepBlock,
      reversal: entryContract.reversal,
      lockedDirection: entryContract.lockedDirection,
      pendingSweep: sweep.pending,
      confirmedSweep: sweep.confirmed,
      confirmedRetest: retest.confirmed,
      alignedChoch: breaks.chochAligned,
      alignedBos: breaks.bosAligned,
      compressionExpansion,
      volatilityState,
      premiumDiscountState: pd.state,
      premiumDiscountScore: pd.score,
      minSupports,
    },
    checkedAt: new Date().toISOString(),
  };
}

export const _test = {
  computePriceRR,
  confirmedAlignedSweep,
  confirmedNativeRetest,
  favorablePremiumDiscount,
  normalizeDirection,
};
