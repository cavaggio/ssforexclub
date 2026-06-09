/**
 * server/ictConcepts.js
 *
 * ICT Engine — pure concept detectors. Each returns the exact shape from the
 * spec and degrades safely on short/empty candle arrays. ICT-first: no RSI /
 * MACD / EMA is used as a qualifier anywhere in this module.
 *
 * Candle shape: { time, open, high, low, close, volume }.
 *
 * Reuses the production-tested primitives rather than re-implementing them:
 *   - detectFairValueGap / detectLiquiditySweep (oandaInstitutionalFlow.js)
 *   - detectFibSetup (oandaFibonacci.js) for the impulse swing / OTE / PD range
 *   - analyzeLiquidity (liquidityEngine.js) for the pool map
 *   - analyzePremiumDiscount (premiumDiscount.js) for premium/discount state
 */

import { getPipSize, toPips, roundPrice } from './pipMath.js';
import { etParts } from './ictTime.js';

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const bodyOf = (c) => Math.abs(c.close - c.open);
const rangeOf = (c) => Math.max(1e-9, c.high - c.low);
const isBull = (c) => c.close > c.open;

function avgBody(candles, lookback) {
  const xs = candles.slice(-lookback - 1, -1);
  if (!xs.length) return 0;
  return xs.reduce((s, c) => s + bodyOf(c), 0) / xs.length;
}

function hiLo(candles) {
  if (!Array.isArray(candles) || !candles.length) return null;
  let high = -Infinity, low = Infinity;
  for (const c of candles) { if (c.high > high) high = c.high; if (c.low < low) low = c.low; }
  return Number.isFinite(high) ? { high, low } : null;
}

// Local swing pivots → arrays of { index, price }.
function findPivots(candles, lookback = 2) {
  const highs = [], lows = [];
  if (!Array.isArray(candles) || candles.length < lookback * 2 + 1) return { highs, lows };
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isH = true, isL = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isH = false;
      if (candles[j].low <= candles[i].low) isL = false;
    }
    if (isH) highs.push({ index: i, price: candles[i].high });
    if (isL) lows.push({ index: i, price: candles[i].low });
  }
  return { highs, lows };
}

// Coarse ET session label for a candle time.
function sessionOfET(time) {
  const et = etParts(time);
  if (!et) return 'off';
  const h = et.hour;
  if (h >= 20) return 'Asian';        // 20:00–24:00 ET
  if (h >= 2 && h < 5) return 'London';
  if (h >= 7 && h < 16) return 'NewYork';
  return 'off';
}

// ─── 2. Imbalance / Fair Value Gap ───────────────────────────────────────────
/**
 * Scan for unmitigated 3-candle FVGs (most recent first). status reflects how
 * much of the gap later price action has filled.
 */
export function detectFVGs({ candles, pair, timeframe = 'M15', max = 4 }) {
  const out = [];
  if (!Array.isArray(candles) || candles.length < 5) return out;
  const avg = avgBody(candles, Math.min(20, candles.length - 1)) || rangeOf(candles[candles.length - 1]);
  for (let i = candles.length - 2; i >= 2; i--) {
    const c1 = candles[i - 2], c2 = candles[i - 1], c3 = candles[i];
    let type = null, gapLow = null, gapHigh = null;
    if (c1.high < c3.low) { type = 'bullish'; gapLow = c1.high; gapHigh = c3.low; }
    else if (c1.low > c3.high) { type = 'bearish'; gapLow = c3.high; gapHigh = c1.low; }
    if (!type) continue;
    // c2 should be the displacement candle (decent body).
    if (bodyOf(c2) < avg * 1.0) continue;
    // Mitigation: how far later candles have eaten into the gap.
    const after = candles.slice(i + 1);
    let status = 'open';
    if (after.length) {
      const deepest = type === 'bullish'
        ? Math.min(...after.map((c) => c.low))
        : Math.max(...after.map((c) => c.high));
      if (type === 'bullish') {
        if (deepest <= gapLow) status = 'filled';
        else if (deepest < gapHigh) status = 'partial';
      } else {
        if (deepest >= gapHigh) status = 'filled';
        else if (deepest > gapLow) status = 'partial';
      }
    }
    const midpoint = roundPrice((gapHigh + gapLow) / 2, pair);
    const sizePips = toPips(gapHigh - gapLow, pair);
    const qualityScore = Math.round(clamp01(
      0.4 + Math.min(0.4, (bodyOf(c2) / (avg || 1) - 1) * 0.3) + (status === 'open' ? 0.2 : status === 'partial' ? 0.1 : 0),
    ) * 100);
    out.push({
      type, timeframe,
      high: roundPrice(gapHigh, pair),
      low: roundPrice(gapLow, pair),
      midpoint, sizePips, status, qualityScore,
    });
    if (out.length >= max) break;
  }
  return out;
}

// ─── 3. Displacement ─────────────────────────────────────────────────────────
export function detectDisplacement({ candles, pair, lookback = 20 }) {
  const blank = { direction: null, candleIndex: null, displacementScore: 0, createdFVG: false };
  if (!Array.isArray(candles) || candles.length < lookback + 3) return blank;
  const avg = avgBody(candles, lookback);
  if (avg <= 0) return blank;

  // Inspect the last few candles; pick the strongest displacement.
  let best = null;
  for (let i = candles.length - 1; i >= candles.length - 4 && i >= 2; i--) {
    const c = candles[i];
    const body = bodyOf(c);
    const bodyRatio = body / avg;
    if (bodyRatio < 1.5) continue;
    const closeLoc = isBull(c)
      ? (c.close - c.low) / rangeOf(c)      // bullish → close near high
      : (c.high - c.close) / rangeOf(c);    // bearish → close near low
    if (closeLoc < 0.6) continue;
    // Short-term structure break: close beyond prior 5-bar extreme.
    const prior = candles.slice(Math.max(0, i - 6), i);
    const priorHi = Math.max(...prior.map((x) => x.high));
    const priorLo = Math.min(...prior.map((x) => x.low));
    const brokeStructure = isBull(c) ? c.close > priorHi : c.close < priorLo;
    // FVG created across this candle (c[i-1].high vs c[i+1>... use i-1,i,i+1 if available]).
    let createdFVG = false;
    if (i + 1 < candles.length) {
      const a = candles[i - 1], b = candles[i + 1];
      createdFVG = isBull(c) ? a.high < b.low : a.low > b.high;
    }
    const score = Math.round(clamp01(
      0.3 + Math.min(0.4, (bodyRatio - 1.5) * 0.2) + closeLoc * 0.2 + (brokeStructure ? 0.15 : 0) + (createdFVG ? 0.1 : 0),
    ) * 100);
    const cand = { direction: isBull(c) ? 'bullish' : 'bearish', candleIndex: i, displacementScore: score, createdFVG, brokeStructure };
    if (!best || cand.displacementScore > best.displacementScore) best = cand;
  }
  return best || blank;
}

// ─── 7. Order Block ──────────────────────────────────────────────────────────
export function detectOrderBlock({ candles, pair }) {
  const blank = { type: null, high: null, low: null, midpoint: null, strengthScore: 0, mitigated: false };
  if (!Array.isArray(candles) || candles.length < 25) return blank;
  const disp = detectDisplacement({ candles, pair });
  if (!disp.direction || disp.candleIndex == null) return blank;

  // The OB is the last opposite-colour candle immediately before displacement.
  const wantBull = disp.direction === 'bullish';
  let obIdx = -1;
  for (let i = disp.candleIndex - 1; i >= Math.max(0, disp.candleIndex - 5); i--) {
    if (wantBull ? !isBull(candles[i]) : isBull(candles[i])) { obIdx = i; break; }
  }
  if (obIdx < 0) return blank;
  const ob = candles[obIdx];
  const after = candles.slice(disp.candleIndex + 1);
  const mitigated = after.some((c) => c.low <= ob.high && c.high >= ob.low);
  const strengthScore = Math.round(clamp01(
    0.4 + (disp.displacementScore / 100) * 0.4 + (disp.createdFVG ? 0.1 : 0) + (disp.brokeStructure ? 0.1 : 0),
  ) * 100);
  return {
    type: wantBull ? 'bullish' : 'bearish',
    high: roundPrice(ob.high, pair),
    low: roundPrice(ob.low, pair),
    midpoint: roundPrice((ob.high + ob.low) / 2, pair),
    strengthScore,
    mitigated,
  };
}

// ─── 4/5/6. MSS (sweep → opposite structure break) ───────────────────────────
export function detectMSS({ candles, pair }) {
  const blank = { direction: null, sweptLevel: null, brokenStructureLevel: null, confirmed: false };
  if (!Array.isArray(candles) || candles.length < 25) return blank;
  const { highs, lows } = findPivots(candles.slice(0, -1));
  const last = candles[candles.length - 1];
  const recent = candles.slice(-6);

  // Bullish MSS: recent bars swept a prior swing low (ran sell-side), last closes
  // back above it AND price breaks the most recent swing high.
  if (lows.length && highs.length) {
    const swingLow = lows[lows.length - 1].price;
    const swingHigh = highs[highs.length - 1].price;
    const sweptLow = recent.some((c) => c.low < swingLow) && last.close > swingLow;
    if (sweptLow && last.close > swingHigh) {
      return { direction: 'bullish', sweptLevel: roundPrice(swingLow, pair), brokenStructureLevel: roundPrice(swingHigh, pair), confirmed: true };
    }
    const swingHi = highs[highs.length - 1].price;
    const swingLo = lows[lows.length - 1].price;
    const sweptHigh = recent.some((c) => c.high > swingHi) && last.close < swingHi;
    if (sweptHigh && last.close < swingLo) {
      return { direction: 'bearish', sweptLevel: roundPrice(swingHi, pair), brokenStructureLevel: roundPrice(swingLo, pair), confirmed: true };
    }
  }
  return blank;
}

// ─── 8. Inducement ───────────────────────────────────────────────────────────
/**
 * A minor swing resting between price and the nearest MAJOR liquidity pool —
 * the level that lures early entries before the real move. We flag whether it
 * exists and whether price has already swept it.
 */
export function detectInducement({ candles, pair, currentPrice, liquidityMap }) {
  const blank = { inducementPresent: false, inducementSwept: false, trapDirection: null };
  if (!Array.isArray(candles) || candles.length < 15 || !Number.isFinite(currentPrice)) return blank;
  const { highs, lows } = findPivots(candles.slice(-30));
  const recent = candles.slice(-6);

  // Nearest minor swing high above price and minor swing low below price.
  const minorHigh = highs.map((h) => h.price).filter((p) => p > currentPrice).sort((a, b) => a - b)[0];
  const minorLow = lows.map((l) => l.price).filter((p) => p < currentPrice).sort((a, b) => b - a)[0];

  const majorAbove = liquidityMap?.buySideLiquidity?.find((l) => l.major)?.price;
  const majorBelow = liquidityMap?.sellSideLiquidity?.find((l) => l.major)?.price;

  // Inducement above: a minor high sitting below a more-distant major buy-side pool.
  if (minorHigh != null && majorAbove != null && minorHigh < majorAbove) {
    const swept = recent.some((c) => c.high > minorHigh);
    return { inducementPresent: true, inducementSwept: swept, trapDirection: 'bullish_trap', level: roundPrice(minorHigh, pair) };
  }
  if (minorLow != null && majorBelow != null && minorLow > majorBelow) {
    const swept = recent.some((c) => c.low < minorLow);
    return { inducementPresent: true, inducementSwept: swept, trapDirection: 'bearish_trap', level: roundPrice(minorLow, pair) };
  }
  return blank;
}

// ─── 17. Turtle Soup ─────────────────────────────────────────────────────────
export function detectTurtleSoup({ candles, pair, liquidityMap }) {
  const blank = { turtleSoupDetected: false, direction: null, sweptEqualLevel: null, reclaimConfirmed: false };
  if (!Array.isArray(candles) || candles.length < 10) return blank;
  const last = candles[candles.length - 1];
  const recent = candles.slice(-5);
  const disp = detectDisplacement({ candles, pair });

  const eqHigh = liquidityMap?.buySideLiquidity?.find((l) => l.source === 'EQH')?.price;
  const eqLow = liquidityMap?.sellSideLiquidity?.find((l) => l.source === 'EQL')?.price;

  // Bullish turtle soup: swept equal lows, reclaimed, displaced up.
  if (eqLow != null) {
    const swept = recent.some((c) => c.low < eqLow);
    const reclaimed = last.close > eqLow;
    if (swept && reclaimed && disp.direction === 'bullish') {
      return { turtleSoupDetected: true, direction: 'bullish', sweptEqualLevel: roundPrice(eqLow, pair), reclaimConfirmed: true };
    }
  }
  if (eqHigh != null) {
    const swept = recent.some((c) => c.high > eqHigh);
    const reclaimed = last.close < eqHigh;
    if (swept && reclaimed && disp.direction === 'bearish') {
      return { turtleSoupDetected: true, direction: 'bearish', sweptEqualLevel: roundPrice(eqHigh, pair), reclaimConfirmed: true };
    }
  }
  return blank;
}

// ─── 18. Judas Swing (London false move on the Asian range) ──────────────────
export function detectJudasSwing({ h1Candles, pair }) {
  const blank = { judasSwingDetected: false, fakeMoveDirection: null, trueMoveDirection: null, asianRangeSwept: false };
  if (!Array.isArray(h1Candles) || h1Candles.length < 12) return blank;

  // Most recent contiguous Asian block, then the London candles that follow it.
  let asian = [];
  let i = h1Candles.length - 1;
  // walk back to find the latest Asian-session run
  const sess = h1Candles.map((c) => sessionOfET(c.time));
  // find last index that is London or NewYork (price now), then the Asian block before it
  let lastAsianEnd = -1;
  for (let k = h1Candles.length - 1; k >= 0; k--) {
    if (sess[k] === 'Asian') { lastAsianEnd = k; break; }
  }
  if (lastAsianEnd < 0) return blank;
  let start = lastAsianEnd;
  while (start > 0 && sess[start - 1] === 'Asian') start--;
  asian = h1Candles.slice(start, lastAsianEnd + 1);
  const london = h1Candles.slice(lastAsianEnd + 1).filter((c) => sessionOfET(c.time) === 'London');
  void i;
  if (asian.length < 2 || london.length < 1) return blank;

  const ar = hiLo(asian);
  if (!ar) return blank;
  const sweptHigh = london.some((c) => c.high > ar.high);
  const sweptLow = london.some((c) => c.low < ar.low);
  const lastLondon = london[london.length - 1];

  // Fake move = the side that was swept; true move = the reversal close direction.
  if (sweptHigh && lastLondon.close < ar.high) {
    return { judasSwingDetected: true, fakeMoveDirection: 'up', trueMoveDirection: 'down', asianRangeSwept: true };
  }
  if (sweptLow && lastLondon.close > ar.low) {
    return { judasSwingDetected: true, fakeMoveDirection: 'down', trueMoveDirection: 'up', asianRangeSwept: true };
  }
  return { ...blank, asianRangeSwept: sweptHigh || sweptLow };
}

// ─── 12. Power of 3 / AMD ────────────────────────────────────────────────────
export function classifyPowerOf3({ h1Candles, pair, now = new Date() }) {
  const et = etParts(now);
  const phase = !et ? 'unknown'
    : et.hour >= 20 || et.hour < 2 ? 'Accumulation'
    : et.hour >= 2 && et.hour < 7 ? 'Manipulation'
    : et.hour >= 7 && et.hour < 16 ? 'Distribution'
    : 'unknown';

  const blank = { phase, asianRange: null, manipulationSide: null, distributionDirection: null };
  if (!Array.isArray(h1Candles) || h1Candles.length < 6) return blank;

  const asian = h1Candles.filter((c) => sessionOfET(c.time) === 'Asian');
  const london = h1Candles.filter((c) => sessionOfET(c.time) === 'London');
  const ny = h1Candles.filter((c) => sessionOfET(c.time) === 'NewYork');
  const ar = hiLo(asian.slice(-8));
  let manipulationSide = null;
  if (ar && london.length) {
    const swH = london.some((c) => c.high > ar.high);
    const swL = london.some((c) => c.low < ar.low);
    manipulationSide = swH && !swL ? 'buy-side' : swL && !swH ? 'sell-side' : swH && swL ? 'both' : null;
  }
  let distributionDirection = null;
  if (ny.length >= 2) distributionDirection = ny[ny.length - 1].close >= ny[0].open ? 'bullish' : 'bearish';

  return {
    phase,
    asianRange: ar ? { high: roundPrice(ar.high, pair), low: roundPrice(ar.low, pair) } : null,
    manipulationSide,
    distributionDirection,
  };
}

// ─── 10. Premium / Discount (mapped to ICT shape) ────────────────────────────
export function computePremiumDiscount({ pair, currentPrice, fib }) {
  const blank = { dealingRangeHigh: null, dealingRangeLow: null, equilibrium: null, currentZone: 'unknown' };
  if (!fib || !Number.isFinite(fib.swingHigh) || !Number.isFinite(fib.swingLow) || !Number.isFinite(currentPrice)) return blank;
  const high = fib.swingHigh, low = fib.swingLow;
  const range = high - low;
  if (!(range > 0)) return blank;
  const eq = (high + low) / 2;
  const pct = (currentPrice - low) / range;
  const currentZone = pct > 0.55 ? 'premium' : pct < 0.45 ? 'discount' : 'equilibrium';
  return {
    dealingRangeHigh: roundPrice(high, pair),
    dealingRangeLow: roundPrice(low, pair),
    equilibrium: roundPrice(eq, pair),
    currentZone,
    pricePositionPct: +clamp01(pct).toFixed(3),
  };
}

// ─── 11. Optimal Trade Entry (62–79% retrace) ────────────────────────────────
export function computeOTE({ pair, currentPrice, fib, direction }) {
  const blank = { oteLow: null, oteHigh: null, priceInOTE: false, oteQuality: 0 };
  if (!fib || !Number.isFinite(fib.swingHigh) || !Number.isFinite(fib.swingLow) || !direction) return blank;
  const high = fib.swingHigh, low = fib.swingLow, range = high - low;
  if (!(range > 0)) return blank;

  // Bullish impulse low→high: retrace DOWN into 62–79% (discount). Levels measured
  // from the swing high. Bearish: retrace UP into 62–79% (premium) from swing low.
  let a, b;
  if (direction === 'long') { a = high - range * 0.62; b = high - range * 0.79; }
  else { a = low + range * 0.62; b = low + range * 0.79; }
  const oteHigh = roundPrice(Math.max(a, b), pair);
  const oteLow = roundPrice(Math.min(a, b), pair);
  const priceInOTE = Number.isFinite(currentPrice) && currentPrice >= oteLow && currentPrice <= oteHigh;
  // Quality peaks at the 70.5% midpoint of the zone.
  let oteQuality = 0;
  if (priceInOTE) {
    const mid = (oteHigh + oteLow) / 2;
    const half = (oteHigh - oteLow) / 2 || 1;
    oteQuality = Math.round(clamp01(1 - Math.abs(currentPrice - mid) / half) * 100);
  }
  return { oteLow, oteHigh, priceInOTE, oteQuality };
}

// ─── 1. Liquidity map (buy/sell-side + previous month + round numbers) ───────
export function buildLiquidityMap({ pair, currentPrice, analyzed, monthlyCandles }) {
  const pools = [...(analyzed?.pools || [])];

  // Previous month high/low from the last completed monthly candle.
  if (Array.isArray(monthlyCandles) && monthlyCandles.length >= 2) {
    const pm = monthlyCandles[monthlyCandles.length - 2];
    pools.push({ label: 'Previous Month High', kind: 'high', price: roundPrice(pm.high, pair), source: 'PMH', distancePips: toPips(pm.high - currentPrice, pair) });
    pools.push({ label: 'Previous Month Low', kind: 'low', price: roundPrice(pm.low, pair), source: 'PML', distancePips: toPips(pm.low - currentPrice, pair) });
  }

  // Psychological round numbers either side of price.
  if (Number.isFinite(currentPrice)) {
    const isJpy = String(pair).includes('JPY');
    const isGold = pair === 'XAU_USD';
    const isSilver = pair === 'XAG_USD';
    const step = isGold ? 10 : isSilver ? 0.5 : isJpy ? 0.5 : 0.005; // 50 pips on FX
    const below = Math.floor(currentPrice / step) * step;
    const above = below + step;
    pools.push({ label: 'Round Number', kind: 'low', price: roundPrice(below, pair), source: 'ROUND', distancePips: toPips(below - currentPrice, pair) });
    pools.push({ label: 'Round Number', kind: 'high', price: roundPrice(above, pair), source: 'ROUND', distancePips: toPips(above - currentPrice, pair) });
  }

  const MAJOR = new Set(['PDH', 'PDL', 'PWH', 'PWL', 'PMH', 'PML', 'ASIA_H', 'ASIA_L', 'LON_H', 'LON_L', 'NY_H', 'NY_L', 'EQH', 'EQL']);
  const tag = (p) => ({ ...p, major: MAJOR.has(p.source) });

  const buySideLiquidity = pools.filter((p) => p.kind === 'high' && p.price > currentPrice).map(tag).sort((a, b) => a.price - b.price);
  const sellSideLiquidity = pools.filter((p) => p.kind === 'low' && p.price < currentPrice).map(tag).sort((a, b) => b.price - a.price);

  const nearestAbove = buySideLiquidity[0] || null;
  const nearestBelow = sellSideLiquidity[0] || null;
  const nearestLiquidity = !nearestAbove ? nearestBelow : !nearestBelow ? nearestAbove
    : Math.abs(nearestAbove.price - currentPrice) <= Math.abs(currentPrice - nearestBelow.price) ? nearestAbove : nearestBelow;

  // Swept liquidity comes from the pool-aware sweep label on analyzeLiquidity.
  const sweptLiquidity = analyzed?.liquiditySweep?.sweptSource
    ? { label: analyzed.liquiditySweep.sweptLiquidity, source: analyzed.liquiditySweep.sweptSource, direction: analyzed.liquiditySweep.direction }
    : null;

  const remainingLiquidity = [...buySideLiquidity, ...sellSideLiquidity]
    .filter((p) => !sweptLiquidity || p.source !== sweptLiquidity.source);

  return { buySideLiquidity, sellSideLiquidity, nearestLiquidity, sweptLiquidity, remainingLiquidity };
}

// ─── 19. IRL / ERL draw ──────────────────────────────────────────────────────
export function irlErlDraw({ pair, currentPrice, liquidityMap, fvgs, orderBlock, bias }) {
  // Internal range liquidity = unmitigated FVGs / OB midpoints inside the range.
  const internal = [];
  for (const f of fvgs || []) if (f.status !== 'filled') internal.push({ label: `${f.type} FVG`, price: f.midpoint });
  if (orderBlock?.midpoint != null && !orderBlock.mitigated) internal.push({ label: `${orderBlock.type} OB`, price: orderBlock.midpoint });

  // External range liquidity = swing highs/lows / PDH-PDL / PWH-PWL pools.
  const external = [...(liquidityMap?.buySideLiquidity || []), ...(liquidityMap?.sellSideLiquidity || [])]
    .filter((p) => p.major);

  const insideInternal = internal.some((x) => Math.abs(x.price - currentPrice) <= Math.abs(currentPrice) * 0.001);
  const currentDraw = insideInternal || internal.length === 0 ? 'ERL' : 'IRL';

  // Next target in the bias direction.
  const dirUp = bias === 'bullish';
  const pool = currentDraw === 'ERL'
    ? external.filter((p) => (dirUp ? p.price > currentPrice : p.price < currentPrice)).sort((a, b) => dirUp ? a.price - b.price : b.price - a.price)[0]
    : internal.filter((p) => (dirUp ? p.price > currentPrice : p.price < currentPrice)).sort((a, b) => dirUp ? a.price - b.price : b.price - a.price)[0];

  return {
    currentDraw,
    nextTarget: pool ? { label: pool.label, price: pool.price } : null,
    targetReason: pool
      ? `Price drawing toward ${currentDraw} (${pool.label}) on ${bias || 'neutral'} bias.`
      : `No clear ${currentDraw} target in bias direction.`,
  };
}

// ─── 9. Daily Bias ───────────────────────────────────────────────────────────
export function computeDailyBias({ pair, currentPrice, dailyCandles, h4Candles, liquidityMap }) {
  const reasons = [];
  let score = 0; // + bullish / - bearish

  if (Array.isArray(dailyCandles) && dailyCandles.length >= 2) {
    const prev = dailyCandles[dailyCandles.length - 2];
    const lastDailyDir = prev.close >= prev.open ? 1 : -1;
    score += lastDailyDir * 0.8;
    reasons.push(`Prev daily candle ${lastDailyDir > 0 ? 'bullish' : 'bearish'}.`);
    if (Number.isFinite(currentPrice)) {
      if (currentPrice > prev.high) { score += 0.5; reasons.push('Price above previous day high.'); }
      else if (currentPrice < prev.low) { score -= 0.5; reasons.push('Price below previous day low.'); }
      else if (currentPrice > prev.close) { score += 0.2; }
      else if (currentPrice < prev.close) { score -= 0.2; }
    }
  }
  if (Array.isArray(h4Candles) && h4Candles.length >= 6) {
    const seg = h4Candles.slice(-6);
    const net = seg[seg.length - 1].close - seg[0].open;
    score += Math.sign(net) * 0.6;
    reasons.push(`Recent 4H structure ${net > 0 ? 'up' : net < 0 ? 'down' : 'flat'}.`);
  }

  // Draw on liquidity: the nearer MAJOR unswept pool tells us where price is pulled.
  let drawOnLiquidity = null;
  const above = liquidityMap?.buySideLiquidity?.find((p) => p.major);
  const below = liquidityMap?.sellSideLiquidity?.find((p) => p.major);
  if (above && below) {
    const dA = Math.abs(above.price - currentPrice), dB = Math.abs(currentPrice - below.price);
    drawOnLiquidity = dA <= dB ? { side: 'buy-side', ...above } : { side: 'sell-side', ...below };
    score += dA <= dB ? 0.3 : -0.3;
  } else if (above) { drawOnLiquidity = { side: 'buy-side', ...above }; }
  else if (below) { drawOnLiquidity = { side: 'sell-side', ...below }; }

  const dailyBias = score >= 0.6 ? 'bullish' : score <= -0.6 ? 'bearish' : 'neutral';
  const confidence = Math.round(clamp01(Math.abs(score) / 2.2) * 100);
  return { dailyBias, drawOnLiquidity, confidence, reason: reasons.join(' ') };
}

// ─── Per-timeframe directional bias (for Daily + 4H alignment gate) ──────────
/**
 * Pure ICT-structure read of a single timeframe's candles → 'bullish' |
 * 'bearish' | 'neutral'. Combines swing structure (HH/HL vs LH/LL) with net
 * directional travel. NO EMA/RSI/MACD. Used to require Daily and 4H to agree.
 */
export function htfBias(candles, lookback = 20) {
  if (!Array.isArray(candles) || candles.length < 8) return 'neutral';
  const seg = candles.slice(-lookback);
  const { highs, lows } = findPivots(seg);
  let structuralBull = false, structuralBear = false;
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs[highs.length - 1].price > highs[highs.length - 2].price;
    const hl = lows[lows.length - 1].price > lows[lows.length - 2].price;
    const lh = highs[highs.length - 1].price < highs[highs.length - 2].price;
    const ll = lows[lows.length - 1].price < lows[lows.length - 2].price;
    structuralBull = hh && hl;
    structuralBear = lh && ll;
  }
  const net = seg[seg.length - 1].close - seg[0].open;
  const span = Math.max(...seg.map((c) => c.high)) - Math.min(...seg.map((c) => c.low));
  const directional = span > 0 && Math.abs(net) / span >= 0.3;
  if (structuralBull && net > 0) return 'bullish';
  if (structuralBear && net < 0) return 'bearish';
  if (directional) return net > 0 ? 'bullish' : 'bearish';
  return 'neutral';
}

// ─── Informational candle descriptor (NEVER a rejection) ─────────────────────
/**
 * Lightweight, non-blocking candle context for display only. ICT evaluates
 * expansion through displacement logic, not a generic candle-strength floor —
 * so this is purely informational.
 */
export function candleContext(candles) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const c = candles[candles.length - 1];
  const range = Math.max(1e-9, c.high - c.low);
  const body = Math.abs(c.close - c.open);
  const prior = candles.slice(-21, -1);
  const avg = prior.length ? prior.reduce((s, x) => s + Math.abs(x.close - x.open), 0) / prior.length : 0;
  return {
    bodyPctOfRange: Math.round((body / range) * 100),
    expansionX: avg > 0 ? +(body / avg).toFixed(2) : null,
    direction: c.close >= c.open ? 'bullish' : 'bearish',
    informationalOnly: true,
  };
}
