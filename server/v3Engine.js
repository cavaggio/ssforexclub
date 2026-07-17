/**
 * server/v3Engine.js
 *
 * Signal Stack V3 — execution-engine orchestrator.
 *
 * Directional alignment is Daily/H4 minimum (67/100), with aligned M15 raising
 * the score to 100/100. H1 remains available to structure and optional chart
 * diagnostics, but Fibonacci does not pass, delay, block, or score an entry.
 */

import { analyzeLiquidity } from './liquidityEngine.js';
import { analyzeMarketStructure } from './marketStructureEngine.js';
import { analyzeSession, buildSessionNarrative } from './sessionEngine.js';
import { analyzeVolatilityExpansion } from './volatilityExpansionEngine.js';
import { computeLiquidityTargets } from './liquidityTargeting.js';
import { analyzeLiquidityIntent } from './liquidityIntent.js';
import { scoreV3, deriveDirection } from './v3ExecutionModel.js';
import { detectFibSetup } from './oandaFibonacci.js';
import { analyzeInstitutionalFlow } from './oandaInstitutionalFlow.js';
import { analyzeV3MarketMovement } from './v3MarketMovement.js';
import { evaluatePrimaryTimeframeAlignment } from './primaryTimeframeAlignment.js';
import { derivePrimaryTimeframes, directionFromDailyH4 } from './v3EntryContract.js';

export const V3_MODE = String(process.env.FOREX_V3_ENGINE_MODE || 'off').toLowerCase();
export function isV3Enabled() { return V3_MODE === 'shadow' || V3_MODE === 'active'; }

function safeFib(args) {
  try { return detectFibSetup(args); } catch { return null; }
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

  const liquidity = analyzeLiquidity({
    pair,
    dailyCandles,
    h4Candles,
    h1Candles,
    m15Candles,
    currentPrice: price,
    direction,
    atrPips,
  });
  const structure = analyzeMarketStructure({ pair, h1Candles, h4Candles, m15Candles });
  const session = analyzeSession({ now, h1Candles, atrPips, atrHistorical });
  const volatility = analyzeVolatilityExpansion({
    pair,
    candles: m15Candles.length ? m15Candles : h4Candles,
    atrPips,
    atrHistorical,
  });
  const structureDirection = deriveDirection({ structure, liquidity, session });

  const institutionalFlow = analyzeInstitutionalFlow({
    pair,
    tradeDirection: direction,
    m15Candles,
    h1Candles,
    h4Candles,
    priorTrend: timeframes.h4,
    structureType:
      structure?.structureTrend === 'ranging' || String(volatility?.volatilityState).toLowerCase() === 'compressed'
        ? 'consolidation'
        : 'trending',
  });

  const marketMovement = analyzeV3MarketMovement({
    pair,
    direction,
    m15Candles,
    h1Candles,
    currentPrice: price,
    atrPips,
    structure,
    volatility,
  });

  // Retained only as optional chart context. It is deliberately excluded from
  // scoring, Stage 1, Stage 2, entry timing, and execution.
  const fib = direction && Number.isFinite(price)
    ? safeFib({ direction, h1Candles, currentPrice: price, pair })
    : null;
  if (fib && typeof fib === 'object') fib.confirmationRole = 'diagnostic_only';

  const liquidityIntent = analyzeLiquidityIntent({
    pair,
    direction,
    currentPrice: price,
    liquidity,
    structure,
    atrPips,
  });
  const sessionNarrative = buildSessionNarrative({ session, liquidity, structure });

  const slPipsEst = Math.max(8, (Number.isFinite(atrPips) ? atrPips : 10) * 1.2);
  const targets = direction && Number.isFinite(price)
    ? computeLiquidityTargets({
        pair,
        direction,
        entryPrice: price,
        stopLossPips: slPipsEst,
        liquidity,
        atrPips,
      })
    : null;

  const scored = scoreV3({
    pair,
    direction,
    liquidity,
    liquidityIntent,
    premiumDiscount: null,
    structure,
    session,
    sessionNarrative,
    volatility,
    momentum,
    emaAlignment: momentum?.m15Alignment,
    targets,
  });

  const earlyTrigger = marketMovement.triggerConfirmed === true;
  const rejectionReasons = (Array.isArray(scored.rejectionReasons) ? scored.rejectionReasons : [])
    .filter((reason) => !String(reason).toLowerCase().includes('no early-entry trigger'));
  if (!earlyTrigger) {
    rejectionReasons.push(
      'No fresh market-movement trigger: waiting for an aligned sweep/reclaim, retest, BOS/CHoCH, or compression expansion.',
    );
  }

  const qualified = rejectionReasons.length === 0 && primaryTimeframeAlignment.passed;

  return {
    mode: V3_MODE,
    direction: primaryTimeframeAlignment.passed ? scored.direction : null,
    structureDirection,
    structureTimeframe: structure.timeframeUsed || null,
    timeframes,
    primaryTimeframeAlignment,
    legacyDirection,
    directionAgrees: scored.direction != null && legacyDirection != null && scored.direction === legacyDirection,
    score: scored.score,
    qualified,
    earlyTrigger,
    rejectionReasons: [
      ...rejectionReasons,
      ...(primaryTimeframeAlignment.passed ? [] : [primaryTimeframeAlignment.reason]),
    ],
    narrative: scored.narrative,
    pillars: scored.pillars,
    fib,
    fibConfirmationPolicy: 'diagnostic_only_not_used',
    targets,
    liquidity,
    liquidityIntent,
    premiumDiscount: null,
    structure,
    session,
    sessionNarrative,
    volatility,
    institutionalFlow,
    marketMovement,
    atrPips,
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
