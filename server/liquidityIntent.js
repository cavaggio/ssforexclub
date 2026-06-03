/**
 * server/liquidityIntent.js
 *
 * Signal Stack V3.5 — Stop-Hunt / Liquidity-Intent engine (the new primary
 * scoring factor).
 *
 *   analyzeLiquidityIntent({ pair, direction, currentPrice, liquidity,
 *                            structure, atrPips })
 *
 * Answers the pre-trade question "where are stops likely resting, and which
 * way is price being drawn?" — BEFORE the move develops. In ICT terms:
 *
 *   - resting liquidity ABOVE old highs   = buy-side liquidity  (shorts' stops)
 *   - resting liquidity BELOW old lows     = sell-side liquidity (longs' stops)
 *
 * Price is drawn toward the heavier / closer pool of resting liquidity. The
 * `liquidityBias` is the side with the stronger draw within a few ATRs; the
 * `expectedLiquidityTarget` is the specific pool most likely to be run.
 *
 * Consumes the pools[] produced by analyzeLiquidity(). PURE / read-only — the
 * `intentScore` is an input to the scoring model, never a hard gate.
 *
 * Output:
 *   {
 *     likelyStopsAbove: [{ label, source, price, distancePips, side }],
 *     likelyStopsBelow: [...],
 *     liquidityBias: 'bullish' | 'bearish' | 'neutral',
 *     expectedLiquidityTarget: pool | null,
 *     intentScore: 0..1,
 *     reasons: []
 *   }
 */

const clamp01 = (x) => Math.max(0, Math.min(1, x));

const MAJOR_SOURCES = new Set([
  'PDH', 'PDL', 'PWH', 'PWL',
  'ASIA_H', 'ASIA_L', 'LON_H', 'LON_L', 'NY_H', 'NY_L',
  'PSESS_H', 'PSESS_L', 'EQH', 'EQL',
]);

const EMPTY = (reason) => ({
  likelyStopsAbove: [],
  likelyStopsBelow: [],
  liquidityBias: 'neutral',
  expectedLiquidityTarget: null,
  intentScore: 0.4,
  reasons: [reason],
});

export function analyzeLiquidityIntent({
  pair,
  direction = null,
  currentPrice = null,
  liquidity = null,
  structure = null,
  atrPips = null,
} = {}) {
  void pair; void structure;
  const pools = liquidity?.pools || [];
  if (!Number.isFinite(currentPrice) || pools.length === 0) {
    return EMPTY('No price/pool context — liquidity intent undetermined.');
  }

  const atr = Number.isFinite(atrPips) && atrPips > 0 ? atrPips : 10;
  const reasons = [];

  // Closeness × significance weight: nearer pools (within ~3×ATR) and major
  // levels draw price harder. distancePips is an absolute distance from price.
  const weightOf = (p) => {
    const dist = Math.abs(Number.isFinite(p.distancePips) ? p.distancePips : 9999);
    const closeness = clamp01(1 - dist / (atr * 3));
    const significance = MAJOR_SOURCES.has(p.source) ? 1 : 0.4;
    return closeness * significance;
  };

  // Buy-side liquidity = highs above price (resting buy stops / breakout buyers).
  // Sell-side liquidity = lows below price (resting sell stops).
  const likelyStopsAbove = pools
    .filter((p) => p.kind === 'high' && p.price > currentPrice)
    .map((p) => ({ label: p.label, source: p.source, price: p.price, distancePips: p.distancePips, side: 'buy-side' }))
    .sort((a, b) => a.price - b.price);
  const likelyStopsBelow = pools
    .filter((p) => p.kind === 'low' && p.price < currentPrice)
    .map((p) => ({ label: p.label, source: p.source, price: p.price, distancePips: p.distancePips, side: 'sell-side' }))
    .sort((a, b) => b.price - a.price);

  const aboveWeight = pools
    .filter((p) => p.kind === 'high' && p.price > currentPrice)
    .reduce((s, p) => s + weightOf(p), 0);
  const belowWeight = pools
    .filter((p) => p.kind === 'low' && p.price < currentPrice)
    .reduce((s, p) => s + weightOf(p), 0);

  const totalWeight = aboveWeight + belowWeight;
  const imbalance = totalWeight > 0 ? Math.abs(aboveWeight - belowWeight) / totalWeight : 0;

  let liquidityBias = 'neutral';
  if (aboveWeight > belowWeight * 1.15) liquidityBias = 'bullish';  // draw UP toward buy-side
  else if (belowWeight > aboveWeight * 1.15) liquidityBias = 'bearish';

  // The single pool most likely to be run: nearest MAJOR on the heavier side,
  // else nearest major overall, else nearest pool.
  const heavySide = liquidityBias === 'bullish' ? likelyStopsAbove
    : liquidityBias === 'bearish' ? likelyStopsBelow
    : [...likelyStopsAbove, ...likelyStopsBelow];
  const byDistance = (arr) => [...arr].sort(
    (a, b) => Math.abs(a.distancePips ?? 9999) - Math.abs(b.distancePips ?? 9999),
  );
  const expectedLiquidityTarget =
    byDistance(heavySide.filter((p) => MAJOR_SOURCES.has(p.source)))[0] ||
    byDistance(heavySide)[0] ||
    null;

  if (expectedLiquidityTarget) {
    reasons.push(`Expected draw on liquidity: ${expectedLiquidityTarget.label} @ ${expectedLiquidityTarget.price} (${expectedLiquidityTarget.distancePips}p).`);
  }
  reasons.push(`Resting liquidity — buy-side ${likelyStopsAbove.length}, sell-side ${likelyStopsBelow.length}; bias ${liquidityBias}.`);

  // Intent score: reward trading TOWARD the heavier resting liquidity (the draw)
  // and having a concrete major target on the trade's far side.
  let intentScore = 0.45;
  if (direction === 'long' || direction === 'short') {
    const dirBias = direction === 'long' ? 'bullish' : 'bearish';
    if (liquidityBias === dirBias) {
      intentScore += 0.3 * imbalance;
      reasons.push(`Direction ${direction} targets the heavier liquidity (draw confirmed).`);
    } else if (liquidityBias !== 'neutral') {
      intentScore -= 0.2 * imbalance;
      reasons.push(`Direction ${direction} trades AWAY from the heavier liquidity draw (${liquidityBias}).`);
    }
    const farSide = direction === 'long' ? likelyStopsAbove : likelyStopsBelow;
    if (farSide.some((p) => MAJOR_SOURCES.has(p.source))) {
      intentScore += 0.15;
      reasons.push('Major liquidity objective sits in the trade direction.');
    }
  }

  return {
    likelyStopsAbove,
    likelyStopsBelow,
    liquidityBias,
    expectedLiquidityTarget,
    intentScore: +clamp01(intentScore).toFixed(3),
    reasons,
  };
}
