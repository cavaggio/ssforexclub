/**
 * server/liquidityEngine.js
 *
 * Signal Stack V3 — Liquidity Analysis Engine.
 *
 *   analyzeLiquidity({ pair, dailyCandles, h4Candles, h1Candles, m15Candles,
 *                      currentPrice, direction, now })
 *
 * Maps where market participants' stops and resting liquidity are likely to be,
 * so the engine can enter as price MOVES TOWARD or AWAY FROM liquidity rather
 * than chasing a confirmed trend. This is the first pillar of the V3 model
 * (priority order: liquidity > structure > session > volatility > momentum > EMA).
 *
 * Tracks the following liquidity pools:
 *   - Previous Day High / Low          (last completed daily candle)
 *   - Previous Week High / Low         (last completed ISO week of daily candles)
 *   - Asian Session High / Low         (most recent completed Asian session)
 *   - Previous Session High / Low      (session immediately before the current one)
 *   - Equal Highs / Equal Lows         (clustered swing pivots = liquidity magnets)
 *
 * Output:
 *   {
 *     pools: [{ label, kind:'high'|'low', price, source, distancePips }],
 *     nearestLiquidityAbove,   // pool | null
 *     nearestLiquidityBelow,   // pool | null
 *     liquidityDistancePips,   // pips to the single nearest pool (either side)
 *     liquiditySweepDetected,  // boolean
 *     liquiditySweep,          // detail object | null
 *     liquidityTarget,         // the pool price most likely to act as a draw
 *     reasons: []
 *   }
 *
 * Reuses the production-tested detectLiquiditySweep() from oandaInstitutionalFlow.js
 * rather than re-implementing the stop-hunt pattern.
 */

import { getPipSize, toPips, roundPrice } from './pipMath.js';
import { detectLiquiditySweep } from './oandaInstitutionalFlow.js';

// Equal highs/lows: pivots within this fraction of ATR (or a pip floor) cluster.
const EQUAL_LEVEL_ATR_FRAC = 0.15;
const EQUAL_LEVEL_MIN_COUNT = 2;
const SWING_LOOKBACK = 2;

// ─── Time / session helpers ──────────────────────────────────────────────────

function utcHour(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.getUTCHours();
}

// Coarse session label by UTC hour — aligned with getForexSession's ranges but
// collapsed to the primary session for bucketing intraday extremes.
function sessionOf(iso) {
  const h = utcHour(iso);
  if (h == null) return null;
  if (h >= 0 && h < 7) return 'Asian';        // Sydney/Tokyo
  if (h >= 7 && h < 12) return 'London';
  if (h >= 12 && h < 20) return 'NewYork';
  return 'Asian';                              // 20–24 Sydney roll into Asian
}

function dayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

// ISO week key (year + week number), good enough to group "previous week".
function weekKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (tmp.getUTCDay() + 6) % 7; // Mon=0
  tmp.setUTCDate(tmp.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((tmp - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7,
  );
  return `${tmp.getUTCFullYear()}-W${week}`;
}

function hiLo(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  let high = -Infinity, low = Infinity;
  for (const c of candles) { if (c.high > high) high = c.high; if (c.low < low) low = c.low; }
  return Number.isFinite(high) && Number.isFinite(low) ? { high, low } : null;
}

/** Group candles into ordered buckets by a key fn, preserving chronological order. */
function bucketize(candles, keyFn) {
  const order = [];
  const map = new Map();
  for (const c of candles || []) {
    const k = keyFn(c.time);
    if (k == null) continue;
    if (!map.has(k)) { map.set(k, []); order.push(k); }
    map.get(k).push(c);
  }
  return order.map((k) => ({ key: k, candles: map.get(k) }));
}

// ─── Equal highs / lows (liquidity magnets) ──────────────────────────────────

function findPivots(candles, lookback = SWING_LOOKBACK) {
  const highs = [];
  const lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highs.push(candles[i].high);
    if (isLow) lows.push(candles[i].low);
  }
  return { highs, lows };
}

function clusterEqual(levels, tolerance) {
  // Return cluster centers where >= EQUAL_LEVEL_MIN_COUNT pivots sit within tolerance.
  const sorted = [...levels].sort((a, b) => a - b);
  const clusters = [];
  let group = [];
  for (const lv of sorted) {
    if (group.length === 0 || Math.abs(lv - group[group.length - 1]) <= tolerance) {
      group.push(lv);
    } else {
      if (group.length >= EQUAL_LEVEL_MIN_COUNT) clusters.push(avg(group));
      group = [lv];
    }
  }
  if (group.length >= EQUAL_LEVEL_MIN_COUNT) clusters.push(avg(group));
  return clusters;
}

function avg(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }

// ─── Main ────────────────────────────────────────────────────────────────────

export function analyzeLiquidity({
  pair,
  dailyCandles = [],
  h4Candles = [],
  h1Candles = [],
  m15Candles = [],
  currentPrice = null,
  direction = null,
  atrPips = null,
} = {}) {
  const reasons = [];
  const pools = [];
  const pipSize = getPipSize(pair);

  const price = Number.isFinite(currentPrice)
    ? currentPrice
    : (m15Candles.length ? m15Candles[m15Candles.length - 1].close : null);

  const addPool = (label, kind, levelPrice, source) => {
    if (!Number.isFinite(levelPrice)) return;
    pools.push({
      label,
      kind,
      price: roundPrice(levelPrice, pair),
      source,
      distancePips: price != null ? toPips(levelPrice - price, pair) : null,
    });
  };

  // Previous Day High / Low — last completed daily candle.
  if (dailyCandles.length >= 1) {
    const prevDay = dailyCandles[dailyCandles.length - 1];
    addPool('Previous Day High', 'high', prevDay.high, 'PDH');
    addPool('Previous Day Low', 'low', prevDay.low, 'PDL');
  }

  // Previous Week High / Low — last completed ISO week of daily candles.
  const weekBuckets = bucketize(dailyCandles, weekKey);
  if (weekBuckets.length >= 2) {
    // The last bucket may be the current (incomplete) week; use the one before it.
    const prevWeek = weekBuckets[weekBuckets.length - 2];
    const wl = hiLo(prevWeek.candles);
    if (wl) { addPool('Previous Week High', 'high', wl.high, 'PWH'); addPool('Previous Week Low', 'low', wl.low, 'PWL'); }
  } else if (weekBuckets.length === 1) {
    const wl = hiLo(weekBuckets[0].candles);
    if (wl) { addPool('Week High', 'high', wl.high, 'PWH'); addPool('Week Low', 'low', wl.low, 'PWL'); }
  }

  // Session extremes from H1 candles, bucketed by (day, session).
  const sessionBuckets = bucketize(h1Candles, (t) => {
    const d = dayKey(t); const s = sessionOf(t);
    return d && s ? `${d}|${s}` : null;
  });
  if (sessionBuckets.length >= 1) {
    // Most recent completed Asian session.
    const asian = [...sessionBuckets].reverse().find((b) => b.key.endsWith('|Asian'));
    if (asian) {
      const al = hiLo(asian.candles);
      if (al) { addPool('Asian Session High', 'high', al.high, 'ASIA_H'); addPool('Asian Session Low', 'low', al.low, 'ASIA_L'); }
    }
    // Previous completed session (the one before the most recent bucket).
    if (sessionBuckets.length >= 2) {
      const prevSession = sessionBuckets[sessionBuckets.length - 2];
      const pl = hiLo(prevSession.candles);
      if (pl) {
        const name = prevSession.key.split('|')[1];
        addPool(`Previous Session High (${name})`, 'high', pl.high, 'PSESS_H');
        addPool(`Previous Session Low (${name})`, 'low', pl.low, 'PSESS_L');
      }
    }
  }

  // Equal highs / equal lows on M15 (fall back to H1) — resting liquidity magnets.
  const eqSource = m15Candles.length >= 40 ? m15Candles : h1Candles;
  if (eqSource.length >= 20) {
    const { highs, lows } = findPivots(eqSource);
    const tol = Math.max(
      pipSize * 2,
      (atrPips != null ? atrPips : 10) * pipSize * EQUAL_LEVEL_ATR_FRAC,
    );
    for (const c of clusterEqual(highs, tol)) addPool('Equal Highs', 'high', c, 'EQH');
    for (const c of clusterEqual(lows, tol)) addPool('Equal Lows', 'low', c, 'EQL');
  }

  // Nearest pools above / below current price.
  let nearestLiquidityAbove = null;
  let nearestLiquidityBelow = null;
  if (price != null) {
    for (const p of pools) {
      if (p.price > price) {
        if (!nearestLiquidityAbove || p.price < nearestLiquidityAbove.price) nearestLiquidityAbove = p;
      } else if (p.price < price) {
        if (!nearestLiquidityBelow || p.price > nearestLiquidityBelow.price) nearestLiquidityBelow = p;
      }
    }
  }

  const aboveDist = nearestLiquidityAbove ? Math.abs(nearestLiquidityAbove.price - price) : Infinity;
  const belowDist = nearestLiquidityBelow ? Math.abs(price - nearestLiquidityBelow.price) : Infinity;
  const nearestDistPips = Number.isFinite(Math.min(aboveDist, belowDist))
    ? toPips(Math.min(aboveDist, belowDist), pair)
    : null;

  // Liquidity sweep — reuse the production detector (M15, then H1).
  let liquiditySweep = m15Candles.length ? detectLiquiditySweep({ candles: m15Candles, pair }) : null;
  if (!liquiditySweep && h1Candles.length) liquiditySweep = detectLiquiditySweep({ candles: h1Candles, pair });
  const liquiditySweepDetected = Boolean(liquiditySweep);
  if (liquiditySweepDetected) reasons.push(liquiditySweep.reason);

  // Liquidity target — the pool the market is most likely being drawn toward.
  // If a direction is supplied, the target is the nearest pool on the far side
  // of the trade (longs draw toward liquidity above; shorts toward below).
  // Otherwise pick the nearest pool overall as the immediate magnet.
  let liquidityTarget = null;
  if (direction === 'long') liquidityTarget = nearestLiquidityAbove;
  else if (direction === 'short') liquidityTarget = nearestLiquidityBelow;
  else liquidityTarget = aboveDist <= belowDist ? nearestLiquidityAbove : nearestLiquidityBelow;

  if (nearestLiquidityAbove) reasons.push(`Nearest liquidity above: ${nearestLiquidityAbove.label} @ ${nearestLiquidityAbove.price} (${nearestLiquidityAbove.distancePips}p).`);
  if (nearestLiquidityBelow) reasons.push(`Nearest liquidity below: ${nearestLiquidityBelow.label} @ ${nearestLiquidityBelow.price} (${nearestLiquidityBelow.distancePips}p).`);

  return {
    pools: pools.sort((a, b) => a.price - b.price),
    nearestLiquidityAbove,
    nearestLiquidityBelow,
    liquidityDistancePips: nearestDistPips,
    liquiditySweepDetected,
    liquiditySweep: liquiditySweep || null,
    liquidityTarget,
    reasons,
  };
}
