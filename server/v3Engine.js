/**
 * server/v3Engine.js
 *
 * Signal Stack V3 — execution-engine orchestrator.
 *
 *   evaluateV3({ pair, legacyDirection, dailyCandles, h4Candles, h1Candles,
 *                m15Candles, currentPrice, atrPips, atrHistorical, momentum, now })
 *
 * Runs the five V3 engines (liquidity, structure, session, volatility, dynamic
 * targeting) and the re-weighted scoring model, and computes the entry-distance-
 * from-move-origin timing metric (the primary KPI for "do we enter earlier").
 *
 * V3 derives its OWN direction (independent of the legacy waterfall) so shadow
 * comparison is meaningful. This module is PURE and side-effect free; the
 * scanner decides what to do with the result based on FOREX_V3_ENGINE_MODE.
 */

import { analyzeLiquidity } from './liquidityEngine.js';
import { analyzeMarketStructure } from './marketStructureEngine.js';
import { analyzeSession } from './sessionEngine.js';
import { analyzeVolatilityExpansion } from './volatilityExpansionEngine.js';
import { computeLiquidityTargets } from './liquidityTargeting.js';
import { scoreV3, deriveDirection } from './v3ExecutionModel.js';
import { detectFibSetup } from './oandaFibonacci.js';
import { getPipSize } from './pipMath.js';

export const V3_MODE = String(process.env.FOREX_V3_ENGINE_MODE || 'off').toLowerCase();
export function isV3Enabled() { return V3_MODE === 'shadow' || V3_MODE === 'active'; }

/**
 * Entry distance from move origin, as a fraction (0..1) of the current impulse.
 * Low = price is near where the move began (early). High = price has already
 * travelled most of the impulse (late). null when no clean impulse is found.
 */
function entryDistanceFromOrigin({ pair, direction, h1Candles, h4Candles, currentPrice }) {
  if (!direction || !Number.isFinite(currentPrice)) return null;
  try {
    const fib = detectFibSetup({ direction, h1Candles, h4Candles, currentPrice, pair });
    if (!fib || !Number.isFinite(fib.swingHigh) || !Number.isFinite(fib.swingLow)) return null;
    const range = Math.abs(fib.swingHigh - fib.swingLow);
    if (range <= 0) return null;
    const origin = direction === 'long' ? fib.swingLow : fib.swingHigh;
    return +Math.min(1.5, Math.abs(currentPrice - origin) / range).toFixed(3);
  } catch {
    return null;
  }
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

  const liquidity = analyzeLiquidity({ pair, dailyCandles, h4Candles, h1Candles, m15Candles, currentPrice: price, atrPips });
  const structure = analyzeMarketStructure({ pair, h1Candles, h4Candles, m15Candles });
  const session = analyzeSession({ now, h1Candles, atrPips, atrHistorical });
  const volatility = analyzeVolatilityExpansion({ pair, candles: m15Candles.length ? m15Candles : h1Candles, atrPips, atrHistorical });

  const direction = deriveDirection({ structure, liquidity, session });

  // Independent V3 stop estimate (the legacy lifecycle SL is computed elsewhere
  // and only for legacy-qualified pairs). Used for the remaining-opportunity gate.
  const slPipsEst = Math.max(8, (Number.isFinite(atrPips) ? atrPips : 10) * 1.2);
  const targets = direction && Number.isFinite(price)
    ? computeLiquidityTargets({ pair, direction, entryPrice: price, stopLossPips: slPipsEst, liquidity, atrPips })
    : null;

  const scored = scoreV3({
    pair,
    direction,
    liquidity,
    structure,
    session,
    volatility,
    momentum,
    emaAlignment: momentum?.m15Alignment,
    targets,
  });

  const entryDistanceFromOriginPct = entryDistanceFromOrigin({
    pair, direction: scored.direction, h1Candles, h4Candles, currentPrice: price,
  });

  return {
    mode: V3_MODE,
    direction: scored.direction,
    legacyDirection,
    directionAgrees: scored.direction != null && legacyDirection != null && scored.direction === legacyDirection,
    score: scored.score,
    qualified: scored.qualified,
    earlyTrigger: scored.earlyTrigger,
    rejectionReasons: scored.rejectionReasons,
    narrative: scored.narrative,
    pillars: scored.pillars,
    entryDistanceFromOriginPct,
    targets,
    liquidity,
    structure,
    session,
    volatility,
    slPipsEst,
  };
}
