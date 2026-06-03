/**
 * server/liquidityTargeting.js
 *
 * Signal Stack V3 — Dynamic Liquidity Targeting (priority pillar #5).
 *
 *   computeLiquidityTargets({ pair, direction, entryPrice, stopLossPips,
 *                             liquidity, atrPips })
 *
 * Replaces static R:R take-profit assumptions with liquidity-pool objectives:
 *   TP1 = nearest liquidity pool in the trade's direction
 *   TP2 = next liquidity pool
 *   TP3 = extended liquidity objective (furthest major pool)
 *
 * Adds "remaining opportunity" analysis: if a MAJOR liquidity level caps the
 * move before the trade can earn an acceptable R:R, the trade is rejected —
 * "insufficient remaining opportunity." This is what stops the engine entering
 * after most of the move has already happened.
 *
 *   { tp1, tp2, tp3, remainingOpportunityPips, expectedMovePotential,
 *     accepted, rejectionReason, targetSource, reasons }
 *
 * `liquidity` is the object returned by analyzeLiquidity().
 */

import { getPipSize, toPips, roundPrice } from './pipMath.js';

const MIN_OPPORTUNITY_RR = parseFloat(process.env.FOREX_V3_MIN_OPPORTUNITY_RR || '1.5');
const MIN_ABS_TP_PIPS = parseFloat(process.env.FOREX_V3_MIN_TP_PIPS || '8');

const MAJOR_SOURCES = new Set(['PDH', 'PDL', 'PWH', 'PWL', 'ASIA_H', 'ASIA_L', 'PSESS_H', 'PSESS_L']);

function tpObject(pool, entryPrice, pair) {
  return {
    label: pool.label,
    source: pool.source,
    price: pool.price,
    pips: toPips(pool.price - entryPrice, pair),
    major: MAJOR_SOURCES.has(pool.source),
  };
}

export function computeLiquidityTargets({
  pair,
  direction,
  entryPrice,
  stopLossPips = null,
  liquidity = null,
  atrPips = null,
} = {}) {
  const reasons = [];
  const pipSize = getPipSize(pair);

  if (!direction || !Number.isFinite(entryPrice)) {
    return blankResult('Missing direction/entryPrice — cannot target.');
  }

  const requiredPips = Math.max(
    MIN_ABS_TP_PIPS,
    Number.isFinite(stopLossPips) ? stopLossPips * MIN_OPPORTUNITY_RR : MIN_ABS_TP_PIPS,
  );

  // Target-side pools: above entry for longs, below for shorts.
  const pools = (liquidity?.pools || []).filter((p) =>
    direction === 'long' ? p.price > entryPrice : p.price < entryPrice,
  );

  // No liquidity map available — fall back to ATR-projected objectives so the
  // trade isn't blocked purely for lack of data.
  if (pools.length === 0) {
    if (!Number.isFinite(atrPips) || atrPips <= 0) {
      return blankResult('No liquidity pools and no ATR — cannot project targets.', 'none', true);
    }
    const mk = (mult) => {
      const pips = +(Math.max(requiredPips, atrPips * mult)).toFixed(1);
      const price = roundPrice(direction === 'long' ? entryPrice + pips * pipSize : entryPrice - pips * pipSize, pair);
      return { label: `ATR ×${mult} projection`, source: 'ATR', price, pips, major: false };
    };
    const tp1 = mk(1.5), tp2 = mk(2.5), tp3 = mk(4);
    reasons.push('No liquidity pools in direction — using ATR-projected TP tiers.');
    return {
      tp1, tp2, tp3,
      remainingOpportunityPips: tp1.pips,
      expectedMovePotential: tp3.pips,
      accepted: true,
      rejectionReason: null,
      targetSource: 'atr_fallback',
      reasons,
    };
  }

  // Sort by distance from entry (ascending).
  const sorted = pools
    .map((p) => tpObject(p, entryPrice, pair))
    .sort((a, b) => Math.abs(a.pips) - Math.abs(b.pips));

  const tp1 = sorted[0] || null;
  const tp2 = sorted[1] || null;
  // TP3 = furthest MAJOR objective if present, else the furthest pool.
  const majors = sorted.filter((t) => t.major);
  const tp3 = (majors.length ? majors[majors.length - 1] : sorted[sorted.length - 1]) || null;

  const remainingOpportunityPips = tp1 ? Math.abs(tp1.pips) : null;
  const expectedMovePotential = tp3 ? Math.abs(tp3.pips) : remainingOpportunityPips;

  // Remaining-opportunity gate: if the NEAREST MAJOR level caps the move before
  // an acceptable R:R, reject — the bulk of the move is likely already gone.
  const nearestMajor = majors[0] || null;
  let accepted = true;
  let rejectionReason = null;

  if (nearestMajor && Math.abs(nearestMajor.pips) < requiredPips) {
    accepted = false;
    rejectionReason =
      `Insufficient remaining opportunity: nearest major liquidity (${nearestMajor.label}) is ` +
      `${Math.abs(nearestMajor.pips)}p away but ${requiredPips.toFixed(0)}p is needed for ` +
      `${MIN_OPPORTUNITY_RR}:1 against a ${stopLossPips ?? '?'}p stop.`;
    reasons.push(rejectionReason);
  } else if (expectedMovePotential != null && expectedMovePotential < requiredPips) {
    accepted = false;
    rejectionReason =
      `Insufficient remaining opportunity: furthest objective only ${expectedMovePotential}p ` +
      `(< required ${requiredPips.toFixed(0)}p).`;
    reasons.push(rejectionReason);
  } else {
    reasons.push(
      `Targets — TP1 ${tp1?.label} (${remainingOpportunityPips}p), ` +
      `TP3 ${tp3?.label} (${expectedMovePotential}p). Remaining opportunity OK vs ${requiredPips.toFixed(0)}p required.`,
    );
  }

  return {
    tp1, tp2, tp3,
    remainingOpportunityPips,
    expectedMovePotential,
    accepted,
    rejectionReason,
    targetSource: 'liquidity',
    reasons,
  };
}

function blankResult(reason, targetSource = 'none', accepted = false) {
  return {
    tp1: null, tp2: null, tp3: null,
    remainingOpportunityPips: null,
    expectedMovePotential: null,
    accepted,
    rejectionReason: accepted ? null : reason,
    targetSource,
    reasons: [reason],
  };
}

export { MIN_OPPORTUNITY_RR, MIN_ABS_TP_PIPS };
