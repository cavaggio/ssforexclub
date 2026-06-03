/**
 * server/premiumDiscount.js
 *
 * Signal Stack V3.5 — Premium / Discount (ICT equilibrium) engine.
 *
 *   analyzePremiumDiscount({ pair, direction, currentPrice, fib })
 *
 * For the most recent dealing-range swing (reused from detectFibSetup — see
 * v3Engine.js), classify where price sits:
 *
 *     0%   ── swing low  ┐
 *     ..   discount      │  buying here (long) is "buying cheap"
 *     45%  ───────────── │
 *     50%  equilibrium   │
 *     55%  ───────────── │
 *     ..   premium       │  selling here (short) is "selling expensive"
 *     100% ── swing high ┘
 *
 * The output never gates a trade. It produces:
 *   - a 0..1 `premiumDiscountScore` (high = price is on the favourable side
 *     for the trade direction), used as an informational pillar note, and
 *   - an `entryQualityPenalty` (0..1) that the scoring model folds into the
 *     liquidity-intent pillar: buying premium / selling discount is penalised.
 *
 * On missing/degenerate data it returns a NEUTRAL result (penalty 0, score
 * 0.5) — we never punish a setup for lack of swing data.
 */

import { toPips, roundPrice } from './pipMath.js';

const clamp01 = (x) => Math.max(0, Math.min(1, x));

function neutral(reason) {
  return {
    enabled: false,
    swingHigh: null,
    swingLow: null,
    swingRangePips: null,
    equilibrium: null,
    pricePositionPct: null,
    premiumDiscountState: 'unknown',
    premiumDiscountScore: 0.5,
    entryQualityPenalty: 0,
    reason,
  };
}

export function analyzePremiumDiscount({ pair, direction, currentPrice, fib } = {}) {
  if (direction !== 'long' && direction !== 'short') {
    return neutral('No direction — premium/discount skipped.');
  }
  if (!Number.isFinite(currentPrice)) {
    return neutral('No current price — premium/discount skipped.');
  }
  if (!fib || !Number.isFinite(fib.swingHigh) || !Number.isFinite(fib.swingLow)) {
    return neutral('No clean impulse swing — premium/discount undetermined.');
  }

  const swingHigh = fib.swingHigh;
  const swingLow = fib.swingLow;
  const swingRange = swingHigh - swingLow;
  if (!(swingRange > 0)) {
    return neutral('Degenerate swing range — premium/discount undetermined.');
  }

  const equilibrium = roundPrice(swingLow + swingRange / 2, pair);
  // 0 = at swing low, 1 = at swing high (absolute, direction-independent).
  const pct = clamp01((currentPrice - swingLow) / swingRange);

  let state;
  if (pct < 0.45) state = 'discount';
  else if (pct > 0.55) state = 'premium';
  else state = 'equilibrium';

  // Penalty: a long above equilibrium is buying premium; a short below it is
  // selling discount. Linear, maxing at the swing extreme.
  const entryQualityPenalty = direction === 'long'
    ? clamp01((pct - 0.5) * 2)
    : clamp01((0.5 - pct) * 2);

  const premiumDiscountScore = +clamp01(1 - entryQualityPenalty).toFixed(3);

  const reason =
    `${direction === 'long' ? 'Long' : 'Short'} with price at ${(pct * 100).toFixed(0)}% of the ` +
    `${toPips(swingRange, pair)}p swing (${state}) — ` +
    (entryQualityPenalty > 0
      ? `${(entryQualityPenalty * 100).toFixed(0)}% entry-quality penalty.`
      : 'favourable side, no penalty.');

  return {
    enabled: true,
    swingHigh,
    swingLow,
    swingRangePips: toPips(swingRange, pair),
    equilibrium,
    pricePositionPct: +pct.toFixed(3),
    premiumDiscountState: state,
    premiumDiscountScore,
    entryQualityPenalty: +entryQualityPenalty.toFixed(3),
    reason,
  };
}
