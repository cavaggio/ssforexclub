import { getPipSize } from './pipMath.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function candlePrices(candle = {}) {
  return {
    open: finite(candle.open ?? candle.o ?? candle.mid?.o),
    high: finite(candle.high ?? candle.h ?? candle.mid?.h),
    low: finite(candle.low ?? candle.l ?? candle.mid?.l),
    close: finite(candle.close ?? candle.c ?? candle.mid?.c),
  };
}

/**
 * Selects the best-fitting ICT model from concepts that were already detected.
 * This is routing, not another confirmation stack: it never rejects a trade and
 * does not add hard gates.
 */
export function classifyIctStrategy(input = {}) {
  const {
    silverBulletWindow = false,
    turtleSoup = false,
    judasSwing = false,
    powerOf3Distribution = false,
    sweepAligned = false,
    displacementAligned = false,
    reversalConfirmed = false,
    bosAligned = false,
    fvgInDir = false,
    obInDir = false,
    inOteZone = false,
    breakerConfirmed = false,
  } = input;

  if (silverBulletWindow) return 'Silver Bullet';
  if (judasSwing) return 'Judas Swing';
  if (turtleSoup) return 'Turtle Soup';
  if (powerOf3Distribution) return 'Power of Three';
  if (breakerConfirmed) return 'Breaker Block';
  if (sweepAligned && displacementAligned && reversalConfirmed && fvgInDir) return 'ICT 2022 Model';
  if (inOteZone && (bosAligned || displacementAligned)) return 'OTE Continuation';
  if (obInDir && (displacementAligned || reversalConfirmed || bosAligned)) return 'Order-Block Mitigation';
  if (fvgInDir && (displacementAligned || bosAligned)) return 'FVG Continuation';
  if (reversalConfirmed) return 'MSS Reversal';
  return 'Liquidity Draw';
}

/**
 * Estimates liquidity-raid / stop-run risk from price only. The result is an
 * execution-risk profile, not a claim that hidden market manipulation is known.
 */
export function buildIctManipulationProfile({
  candles = [],
  atrPrice = null,
  sweep = null,
  direction = 'long',
} = {}) {
  const usable = (Array.isArray(candles) ? candles : [])
    .slice(-10)
    .map(candlePrices)
    .filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite));

  const atr = finite(atrPrice);
  const againstWicks = [];
  const ranges = [];

  for (const candle of usable) {
    const bodyHigh = Math.max(candle.open, candle.close);
    const bodyLow = Math.min(candle.open, candle.close);
    const wick = direction === 'short'
      ? Math.max(0, candle.high - bodyHigh)
      : Math.max(0, bodyLow - candle.low);
    againstWicks.push(wick);
    ranges.push(Math.max(0, candle.high - candle.low));
  }

  const maxAgainstWick = againstWicks.length ? Math.max(...againstWicks) : 0;
  const recentRange = ranges.at(-1) ?? 0;
  const priorRanges = ranges.slice(0, -1);
  const averagePriorRange = priorRanges.length
    ? priorRanges.reduce((sum, value) => sum + value, 0) / priorRanges.length
    : recentRange;
  const wickAtr = atr && atr > 0 ? maxAgainstWick / atr : 0;
  const expansionRatio = averagePriorRange > 0 ? recentRange / averagePriorRange : 1;
  const repeatedWicks = atr && atr > 0
    ? againstWicks.filter((wick) => wick >= atr * 0.35).length
    : 0;
  const confirmedSweep = Boolean(sweep && sweep.pending !== true);

  let score = 0;
  if (confirmedSweep) score += 35;
  score += clamp(wickAtr * 25, 0, 30);
  score += clamp(repeatedWicks * 8, 0, 24);
  score += clamp((expansionRatio - 1) * 20, 0, 20);
  score = Math.round(clamp(score, 0, 100));

  const risk = score >= 65 ? 'high' : score >= 40 ? 'medium' : 'low';
  const atrBufferMultiplier = risk === 'high' ? 1.9 : risk === 'medium' ? 1.45 : 1;

  return {
    score,
    risk,
    confirmedSweep,
    wickAtr: +wickAtr.toFixed(2),
    expansionRatio: +expansionRatio.toFixed(2),
    repeatedWicks,
    atrBufferMultiplier,
  };
}

/**
 * Places the initial stop beyond structural invalidation with an ATR/liquidity-
 * raid buffer. This runs before the order is submitted. It must never be used to
 * move an already-live stop farther away.
 */
export function computeAdaptiveIctStop({
  pair,
  direction,
  entry,
  zoneLow,
  zoneHigh,
  sweptLevel = null,
  atrPrice = null,
  pipSize = null,
  candles = [],
  sweep = null,
} = {}) {
  const bull = direction === 'long' || direction === 'bullish' || direction === 'buy';
  const bear = direction === 'short' || direction === 'bearish' || direction === 'sell';
  const entryPrice = finite(entry);
  const pip = finite(pipSize) ?? getPipSize(pair);
  const atr = finite(atrPrice);
  const low = finite(zoneLow) ?? entryPrice;
  const high = finite(zoneHigh) ?? entryPrice;
  const swept = finite(sweptLevel);

  if ((!bull && !bear) || !Number.isFinite(entryPrice) || !Number.isFinite(pip) || pip <= 0) {
    return { ok: false, reason: 'Invalid ICT adaptive-stop inputs.' };
  }

  const profile = buildIctManipulationProfile({ candles, atrPrice: atr, sweep, direction: bull ? 'long' : 'short' });
  const baseBuffer = Math.max(5 * pip, atr && atr > 0 ? atr * 0.35 : 0);
  const appliedBuffer = baseBuffer * profile.atrBufferMultiplier;
  const structuralBoundary = bull
    ? Math.min(low, swept ?? low)
    : Math.max(high, swept ?? high);
  const stopLoss = bull
    ? structuralBoundary - appliedBuffer
    : structuralBoundary + appliedBuffer;

  return {
    ok: true,
    stopLoss,
    structuralBoundary,
    bufferPrice: appliedBuffer,
    bufferPips: +(appliedBuffer / pip).toFixed(1),
    baseBufferPips: +(baseBuffer / pip).toFixed(1),
    initialRiskPips: +(Math.abs(entryPrice - stopLoss) / pip).toFixed(1),
    manipulation: profile,
    rule: 'pre_entry_structural_invalidation_plus_atr_liquidity_raid_buffer',
  };
}

/**
 * Applies an optional advisor recommendation within deterministic limits. Claude
 * may widen the initial stop only; it cannot tighten it, change direction, move
 * an existing live stop, or reduce the final R:R below the configured minimum.
 */
export function applyBoundedIctStopWidening({
  pair,
  direction,
  entry,
  stopLoss,
  targetProfit,
  suggestedExtraPips = 0,
  atrPips = null,
  minRR = 1.5,
  maxAdvisorAtrFraction = 0.5,
} = {}) {
  const bull = direction === 'long';
  const bear = direction === 'short';
  const entryPrice = finite(entry);
  const currentStop = finite(stopLoss);
  const target = finite(targetProfit);
  const pip = getPipSize(pair);
  const suggestion = Math.max(0, finite(suggestedExtraPips) ?? 0);
  const floor = Math.max(1.5, finite(minRR) ?? 1.5);

  if ((!bull && !bear) || ![entryPrice, currentStop, target, pip].every(Number.isFinite) || pip <= 0) {
    return { adjusted: false, stopLoss: currentStop, reason: 'invalid_bounded_stop_inputs' };
  }

  const currentRisk = Math.abs(entryPrice - currentStop);
  const reward = Math.abs(target - entryPrice);
  const maxRiskByRR = reward / floor;
  const roomByRR = Math.max(0, maxRiskByRR - currentRisk);
  const atrCapPips = Number.isFinite(finite(atrPips))
    ? Math.max(0, finite(atrPips) * maxAdvisorAtrFraction)
    : suggestion;
  const extraPips = Math.min(suggestion, atrCapPips, roomByRR / pip);

  if (!(extraPips > 0)) {
    return {
      adjusted: false,
      stopLoss: currentStop,
      extraPips: 0,
      actualRR: currentRisk > 0 ? +(reward / currentRisk).toFixed(2) : null,
      reason: roomByRR <= 0 ? 'minimum_rr_has_no_room_for_wider_stop' : 'no_advisor_widening',
    };
  }

  const widenedStop = bull ? currentStop - extraPips * pip : currentStop + extraPips * pip;
  const widenedRisk = Math.abs(entryPrice - widenedStop);
  const actualRR = widenedRisk > 0 ? reward / widenedRisk : 0;

  return {
    adjusted: true,
    stopLoss: widenedStop,
    extraPips: +extraPips.toFixed(1),
    actualRR: +actualRR.toFixed(2),
    reason: 'bounded_pre_entry_advisor_widening',
  };
}

export function isIctTradeRecord(record = {}) {
  const strategy = String(record.entryStrategy ?? record.strategy ?? record.engine ?? '').toLowerCase();
  return strategy === 'ict' || strategy.startsWith('ict_') || strategy.includes('inner circle trader');
}

export function ictHoldMinutes(record = {}, fallback = null) {
  const configured = finite(record.entryExpectedHoldTimeMinutes ?? record.holdMinutes ?? fallback);
  const defaultHold = finite(process.env.ICT_HOLD_MINUTES_DEFAULT) ?? 120;
  return clamp(configured ?? defaultHold, 15, 240);
}

export function ictEntryConfidence(record = {}, fallback = 93) {
  const confidence = finite(
    record.entryQualityConfidence ??
    record.entryTpHitConfidence ??
    record.confidence ??
    fallback,
  );
  return clamp(confidence ?? fallback, 0, 100);
}

/**
 * Confidence is locked to the qualified entry value during the planned hold.
 * After the hold expires, only ICT lifecycle evidence and trade progress change
 * it; the legacy entry-confidence waterfall is deliberately excluded.
 */
export function computeIctLifecycleConfidence({
  entryConfidence,
  minutesElapsed,
  holdMinutes,
  lifecycleAction = 'HOLD',
  profitR = 0,
  tpProgress = 0,
} = {}) {
  const base = clamp(finite(entryConfidence) ?? 93, 0, 100);
  const elapsed = Math.max(0, finite(minutesElapsed) ?? 0);
  const hold = Math.max(15, finite(holdMinutes) ?? 120);

  if (elapsed < hold) return Math.round(base);

  const action = String(lifecycleAction || 'HOLD').toUpperCase();
  const elapsedBeyondHold = Math.max(0, elapsed - hold);
  const timeDecay = Math.min(12, (elapsedBeyondHold / hold) * 8);
  const progressBonus = Math.min(6, Math.max(0, finite(tpProgress) ?? 0) * 6)
    + Math.min(4, Math.max(0, finite(profitR) ?? 0) * 2);
  const actionPenalty = action === 'CLOSE' || action === 'EXIT' || action === 'EXIT_NOW'
    ? 28
    : action === 'TIGHTEN_STOP'
      ? 10
      : action === 'PARTIAL_CLOSE'
        ? 3
        : 0;

  return Math.round(clamp(base - timeDecay - actionPenalty + progressBonus, 0, 100));
}
