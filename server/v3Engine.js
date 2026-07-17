/**
 * server/v3Engine.js
 *
 * Signal Stack V3 — execution-engine orchestrator.
 *
 *   evaluateV3({ pair, legacyDirection, dailyCandles, h4Candles, h1Candles,
 *                m15Candles, currentPrice, atrPips, atrHistorical, momentum, now })
 *
 * Directional alignment is Daily/H4 minimum (67/100), with aligned M15 raising
 * the score to 100/100. H1 is excluded from that alignment calculation, but it
 * remains available to independent V3 market-structure and Fibonacci analysis.
 */

import { analyzeLiquidity } from './liquidityEngine.js';
import { analyzeMarketStructure } from './marketStructureEngine.js';
import { analyzeSession, buildSessionNarrative } from './sessionEngine.js';
import { analyzeVolatilityExpansion } from './volatilityExpansionEngine.js';
import { computeLiquidityTargets } from './liquidityTargeting.js';
import { analyzeLiquidityIntent } from './liquidityIntent.js';
import { analyzePremiumDiscount } from './premiumDiscount.js';
import { scoreV3, deriveDirection } from './v3ExecutionModel.js';
import { detectFibSetup } from './oandaFibonacci.js';
import { getPipSize } from './pipMath.js';
import { evaluatePrimaryTimeframeAlignment } from './primaryTimeframeAlignment.js';
import { derivePrimaryTimeframes, directionFromDailyH4 } from './v3EntryContract.js';

export const V3_MODE = String(process.env.FOREX_V3_ENGINE_MODE || 'off').toLowerCase();
export function isV3Enabled() { return V3_MODE === 'shadow' || V3_MODE === 'active'; }

/** detectFibSetup wrapped so a bad candle set can never throw out of evaluateV3. */
function safeFib(args) {
  try { return detectFibSetup(args); } catch { return null; }
}

/**
 * Entry distance from move origin, as a fraction (0..1) of the current impulse.
 * Low = price is near where the move began (early). High = price has already
 * travelled most of the impulse (late). null when no clean impulse is found.
 */
function entryDistanceFromOrigin({ direction, fib, currentPrice }) {
  if (!direction || !Number.isFinite(currentPrice) || !fib) return null;
  if (!Number.isFinite(fib.swingHigh) || !Number.isFinite(fib.swingLow)) return null;
  const range = Math.abs(fib.swingHigh - fib.swingLow);
  if (range <= 0) return null;
  const origin = direction === 'long' ? fib.swingLow : fib.swingHigh;
  return +Math.min(1.5, Math.abs(currentPrice - origin) / range).toFixed(3);
}

export function evaluateV3({
  pair,
  legacyDirection = null,
  dailyCandles = [],
  h4Candles = [],
  h1Candles = [],
  m15Candles = [],
  currentPrice = null,
  atrPips = null,
  atrHistorical = null,
  momentum = null,
  now = null,
} = {}) {
  const price = Number.isFinite(currentPrice)
    ? currentPrice
    : (m15Candles.length ? m15Candles[m15Candles.length - 1].close : null);

  const timeframes = derivePrimaryTimeframes({ dailyCandles, h4Candles, m15Candles });
  const direction = directionFromDailyH4(timeframes);
  const primaryTimeframeAlignment = evaluatePrimaryTimeframeAlignment({ timeframes }, direction);

  // Alignment is determined only by Daily/H4/M15. H1 remains available to the
  // separate liquidity, session, market-structure, and Fibonacci analysis layers.
  const liquidity = analyzeLiquidity({ pair, dailyCandles, h4Candles, h1Candles, m15Candles, currentPrice: price, atrPips });
  const structure = analyzeMarketStructure({ pair, h1Candles, h4Candles, m15Candles });
  const session = analyzeSession({ now, h1Candles, atrPips, atrHistorical });
  const volatility = analyzeVolatilityExpansion({ pair, candles: m15Candles.length ? m15Candles : h4Candles, atrPips, atrHistorical });

  const structureDirection = deriveDirection({ structure, liquidity, session });

  // Fibonacci impulse/retracement analysis remains H1-specific.
  const fib = direction && Number.isFinite(price)
    ? safeFib({ direction, h1Candles, currentPrice: price, pair })
    : null;

  const liquidityIntent = analyzeLiquidityIntent({ pair, direction, currentPrice: price, liquidity, structure, atrPips });
  const premiumDiscount = analyzePremiumDiscount({ pair, direction, currentPrice: price, fib });
  const sessionNarrative = buildSessionNarrative({ session, liquidity, structure });

  const slPipsEst = Math.max(8, (Number.isFinite(atrPips) ? atrPips : 10) * 1.2);
  const targets = direction && Number.isFinite(price)
    ? computeLiquidityTargets({ pair, direction, entryPrice: price, stopLossPips: slPipsEst, liquidity, atrPips })
    : null;

  const scored = scoreV3({
    pair,
    direction,
    liquidity,
    liquidityIntent,
    premiumDiscount,
    structure,
    session,
    sessionNarrative,
    volatility,
    momentum,
    emaAlignment: momentum?.m15Alignment,
    targets,
  });

  const entryDistanceFromOriginPct = entryDistanceFromOrigin({
    direction: scored.direction, fib, currentPrice: price,
  });

  return {
    mode: V3_MODE,
    direction: primaryTimeframeAlignment.passed ? scored.direction : null,
    structureDirection,
    structureTimeframe: structure.timeframeUsed || null,
    fibTimeframe: fib?.timeframeUsed || 'H1',
    timeframes,
    primaryTimeframeAlignment,
    legacyDirection,
    directionAgrees: scored.direction != null && legacyDirection != null && scored.direction === legacyDirection,
    score: scored.score,
    qualified: scored.qualified && primaryTimeframeAlignment.passed,
    earlyTrigger: scored.earlyTrigger,
    rejectionReasons: [
      ...scored.rejectionReasons,
      ...(primaryTimeframeAlignment.passed ? [] : [primaryTimeframeAlignment.reason]),
    ],
    narrative: scored.narrative,
    pillars: scored.pillars,
    entryDistanceFromOriginPct,
    fib,
    targets,
    liquidity,
    liquidityIntent,
    premiumDiscount,
    structure,
    session,
    sessionNarrative,
    volatility,
    slPipsEst,
  };
}

// June 23 soft-filter scoring
// These filters should influence confidence, not hard-reject otherwise valid trades.
export function applyJune23SoftFilterScoring(candidate = {}) {
  let confidenceAdjustment = 0;
  const softReasons = [];

  if (candidate.regimeAligned === true) {
    confidenceAdjustment += 1;
    softReasons.push('Regime aligned: +1 confidence');
  } else if (candidate.regimeAligned === false) {
    confidenceAdjustment -= 1;
    softReasons.push('Regime not aligned: -1 confidence');
  }

  if (candidate.liquidityIntentStrong === true) {
    confidenceAdjustment += 2;
    softReasons.push('Strong liquidity intent: +2 confidence');
  } else if (candidate.liquidityIntentStrong === false) {
    confidenceAdjustment -= 1;
    softReasons.push('Weak liquidity intent: -1 confidence');
  }

  if (candidate.calibrationPositive === true) {
    confidenceAdjustment += 1;
    softReasons.push('Positive calibration: +1 confidence');
  } else if (candidate.calibrationPositive === false) {
    confidenceAdjustment -= 1;
    softReasons.push('Negative calibration: -1 confidence');
  }

  if (candidate.smtDivergence === true) {
    confidenceAdjustment += 1;
    softReasons.push('SMT divergence present: +1 confidence');
  }

  if (candidate.sessionNarrativeAligned === true) {
    confidenceAdjustment += 1;
    softReasons.push('Session narrative aligned: +1 confidence');
  }

  const baseConfidence = Number(candidate.confidence ?? 0);
  const finalConfidence = Math.max(0, Math.min(100, baseConfidence + confidenceAdjustment));

  return {
    ...candidate,
    baseConfidence,
    confidence: finalConfidence,
    confidenceAdjustment,
    softReasons,
  };
}
