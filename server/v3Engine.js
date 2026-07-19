/**
 * server/v3Engine.js
 *
 * Signal Stack V3 — independent execution-engine orchestrator.
 *
 * Directional alignment is Daily/H4 minimum (67/100), with aligned M15 raising
 * the score to 100/100. H1 remains available to structure and optional chart
 * diagnostics, but Fibonacci does not pass, delay, block, or score an entry.
 *
 * Boundary rule: V3 accepts raw market data only. It does not accept a direction,
 * confidence, candidate, confirmation, or decision produced by another engine.
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

  // Optional chart context only. It is excluded from scoring, Stage 1, Stage 2,
  // entry timing, and execution.
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
    engine: 'v3',
    architecture: 'independent_v3_raw_market_data',
    direction: primaryTimeframeAlignment.passed ? scored.direction : null,
    structureDirection,
    structureTimeframe: structure.timeframeUsed || null,
    timeframes,
    primaryTimeframeAlignment,
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
