/**
 * server/oandaInstitutionalFlow.js
 *
 * Price-action proxies for institutional order-flow.
 *
 * We do not have access to a real order book, dark-pool prints, or volume
 * profile data on OANDA's spot feed. This module approximates that picture
 * from candle structure alone — the same patterns smart-money traders use:
 *
 *   detectLiquiditySweep       — stop-run above recent high / below recent low
 *                                 followed by a rejection wick + close back inside
 *   detectBreakOfStructure     — close beyond the most recent swing pivot in
 *                                 the trade direction (continuation signal)
 *   detectChangeOfCharacter    — first close that breaks the prior trend's
 *                                 swing pivot in the OPPOSITE direction
 *                                 (potential reversal signal)
 *   detectFairValueGap         — 3-candle imbalance where candle 1's wick
 *                                 doesn't overlap candle 3's wick
 *   detectRangeBreakout        — close outside a tight consolidation range
 *                                 (with a +ATR-expansion check)
 *   detectRetest               — price returns to a recently broken level
 *                                 without reclaiming it
 *   detectWickRejection        — last candle prints a long wick on the side
 *                                 of price action
 *   detectAtrExpansion         — current ATR ≥ 1.4× ATR-of-prior-window
 *                                 after a compressed phase
 *
 * `analyzeInstitutionalFlow({...})` runs all detectors against M15 + H1 + H4
 * and folds the results into the final signal object spec'd by the user:
 *
 *   {
 *     detected: boolean,
 *     type: 'liquidity_sweep' | 'break_of_structure' | 'choch' | 'range_breakout'
 *           | 'retest' | 'imbalance' | 'wick_rejection' | 'atr_expansion' | 'none',
 *     direction: 'bullish' | 'bearish' | 'neutral',
 *     confidenceImpact: number,         // -25 .. +25
 *     reason: string,
 *     signals: [ ... per-detector outputs ... ]
 *   }
 */

import { atr } from './oandaIndicators.js';

const SWING_LOOKBACK = 3;

function getPipSize(pair) {
  if (String(pair || '').includes('JPY'))          return 0.01;
  if (pair === 'XAU_USD' || pair === 'XAG_USD')    return 0.01;
  return 0.0001;
}

function pricePrecision(pair) {
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return 2;
  if (String(pair || '').includes('JPY'))       return 3;
  return 5;
}

function findPivots(candles, lookback = SWING_LOOKBACK) {
  const highs = [];
  const lows  = [];
  if (!Array.isArray(candles) || candles.length < lookback * 2 + 1) return { highs, lows };
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true;
    let isLow  = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low  <= candles[i].low)  isLow  = false;
    }
    if (isHigh) highs.push({ index: i, price: candles[i].high });
    if (isLow)  lows.push ({ index: i, price: candles[i].low  });
  }
  return { highs, lows };
}

function lastN(arr, n) { return arr.slice(Math.max(0, arr.length - n)); }

// ─── Detector 1: Liquidity sweep ─────────────────────────────────────────────
/**
 * A liquidity sweep prints when price spikes through a recent swing extreme,
 * runs the stops sitting just beyond it, then closes back inside the range —
 * the classic "stop hunt" pattern that often precedes a reversal in the
 * opposite direction.
 *
 * Detection (last 6 bars):
 *   - Find the highest swing high / lowest swing low formed BEFORE the last 6 bars.
 *   - If any of the last 3 bars' WICKS pierced that level, but the most recent
 *     bar CLOSED back inside, we count it as a sweep.
 */
export function detectLiquiditySweep({ candles, pair }) {
  if (!Array.isArray(candles) || candles.length < 20) return null;
  const pipSize = getPipSize(pair);

  const recent = candles.slice(-6);
  const lookback = candles.slice(-30, -6);
  if (lookback.length < 10) return null;

  const lookbackHigh = Math.max(...lookback.map(c => c.high));
  const lookbackLow  = Math.min(...lookback.map(c => c.low));

  const last = recent[recent.length - 1];
  const last3 = recent.slice(-3);

  // Bearish sweep: stops above the high run, last candle closes back below it.
  const piercedHigh = last3.some(c => c.high > lookbackHigh);
  if (piercedHigh && last.close < lookbackHigh) {
    const swept = Math.max(...last3.map(c => c.high)) - lookbackHigh;
    const sweptPips = +(swept / pipSize).toFixed(1);
    return {
      type: 'liquidity_sweep',
      direction: 'bearish',
      sweptPriceLevel: +lookbackHigh.toFixed(pricePrecision(pair)),
      sweptPips,
      reason: `Wick ran ${sweptPips}p above recent high ${lookbackHigh.toFixed(pricePrecision(pair))} then closed back inside — stops swept, bearish bias`,
    };
  }

  const piercedLow = last3.some(c => c.low < lookbackLow);
  if (piercedLow && last.close > lookbackLow) {
    const swept = lookbackLow - Math.min(...last3.map(c => c.low));
    const sweptPips = +(swept / pipSize).toFixed(1);
    return {
      type: 'liquidity_sweep',
      direction: 'bullish',
      sweptPriceLevel: +lookbackLow.toFixed(pricePrecision(pair)),
      sweptPips,
      reason: `Wick ran ${sweptPips}p below recent low ${lookbackLow.toFixed(pricePrecision(pair))} then closed back inside — stops swept, bullish bias`,
    };
  }

  return null;
}

// ─── Detector 2: Break of structure ──────────────────────────────────────────
/**
 * BOS = price closes BEYOND the most recent swing in the trend direction —
 * confirmation that the trend is continuing.
 */
export function detectBreakOfStructure({ candles, direction, pair }) {
  if (!Array.isArray(candles) || candles.length < 20) return null;
  const { highs, lows } = findPivots(candles.slice(0, -1));
  const last = candles[candles.length - 1];

  if (direction === 'long') {
    const mostRecentHigh = highs.length ? highs[highs.length - 1] : null;
    if (!mostRecentHigh) return null;
    if (last.close > mostRecentHigh.price) {
      return {
        type: 'break_of_structure',
        direction: 'bullish',
        brokenLevel: +mostRecentHigh.price.toFixed(pricePrecision(pair)),
        reason: `Last bar closed above swing high ${mostRecentHigh.price.toFixed(pricePrecision(pair))} — bullish BOS`,
      };
    }
  }
  if (direction === 'short') {
    const mostRecentLow = lows.length ? lows[lows.length - 1] : null;
    if (!mostRecentLow) return null;
    if (last.close < mostRecentLow.price) {
      return {
        type: 'break_of_structure',
        direction: 'bearish',
        brokenLevel: +mostRecentLow.price.toFixed(pricePrecision(pair)),
        reason: `Last bar closed below swing low ${mostRecentLow.price.toFixed(pricePrecision(pair))} — bearish BOS`,
      };
    }
  }
  return null;
}

// ─── Detector 3: Change of Character (CHoCH) ────────────────────────────────
/**
 * CHoCH = first close that breaks the prior trend's swing pivot in the
 * OPPOSITE direction. It precedes a real reversal.
 *
 *   In an uptrend: a lower-high then a close beneath the prior swing low → bearish CHoCH
 *   In a downtrend: a higher-low then a close above the prior swing high → bullish CHoCH
 */
export function detectChangeOfCharacter({ candles, priorTrend, pair }) {
  if (!Array.isArray(candles) || candles.length < 25) return null;
  if (priorTrend !== 'bullish' && priorTrend !== 'bearish') return null;

  const { highs, lows } = findPivots(candles.slice(0, -1));
  const last = candles[candles.length - 1];

  if (priorTrend === 'bullish' && lows.length >= 2) {
    // Look for a most-recent low that is LOWER than the prior low (lower-low)
    const lastLow = lows[lows.length - 1];
    const prevLow = lows[lows.length - 2];
    if (lastLow.price < prevLow.price && last.close < lastLow.price) {
      return {
        type: 'choch',
        direction: 'bearish',
        brokenLevel: +lastLow.price.toFixed(pricePrecision(pair)),
        reason: `Bullish trend printed lower-low ${lastLow.price.toFixed(pricePrecision(pair))} then closed beneath it — bearish CHoCH`,
      };
    }
  }
  if (priorTrend === 'bearish' && highs.length >= 2) {
    const lastHigh = highs[highs.length - 1];
    const prevHigh = highs[highs.length - 2];
    if (lastHigh.price > prevHigh.price && last.close > lastHigh.price) {
      return {
        type: 'choch',
        direction: 'bullish',
        brokenLevel: +lastHigh.price.toFixed(pricePrecision(pair)),
        reason: `Bearish trend printed higher-high ${lastHigh.price.toFixed(pricePrecision(pair))} then closed above it — bullish CHoCH`,
      };
    }
  }
  return null;
}

// ─── Detector 4: Fair Value Gap (3-candle imbalance) ────────────────────────
/**
 * FVG: candle1.high < candle3.low (bullish gap) or candle1.low > candle3.high
 * (bearish gap). The middle candle's full body sits in unfilled space.
 */
export function detectFairValueGap({ candles, pair }) {
  if (!Array.isArray(candles) || candles.length < 4) return null;
  const pipSize = getPipSize(pair);

  // Check the most recent completed 3-candle window
  const c1 = candles[candles.length - 4];
  const c2 = candles[candles.length - 3];
  const c3 = candles[candles.length - 2];

  // Bullish FVG: c1.high < c3.low — a gap up
  if (c1.high < c3.low) {
    const gap = c3.low - c1.high;
    const gapPips = +(gap / pipSize).toFixed(1);
    return {
      type: 'imbalance',
      direction: 'bullish',
      gapLow:  +c1.high.toFixed(pricePrecision(pair)),
      gapHigh: +c3.low.toFixed(pricePrecision(pair)),
      gapPips,
      reason: `Bullish 3-candle FVG: ${gapPips}p gap between ${c1.high.toFixed(pricePrecision(pair))}–${c3.low.toFixed(pricePrecision(pair))}`,
    };
  }
  // Bearish FVG: c1.low > c3.high — a gap down
  if (c1.low > c3.high) {
    const gap = c1.low - c3.high;
    const gapPips = +(gap / pipSize).toFixed(1);
    return {
      type: 'imbalance',
      direction: 'bearish',
      gapHigh: +c1.low.toFixed(pricePrecision(pair)),
      gapLow:  +c3.high.toFixed(pricePrecision(pair)),
      gapPips,
      reason: `Bearish 3-candle FVG: ${gapPips}p gap between ${c3.high.toFixed(pricePrecision(pair))}–${c1.low.toFixed(pricePrecision(pair))}`,
    };
  }
  return null;
}

// ─── Detector 5: Range breakout (+ ATR expansion) ───────────────────────────
/**
 * A consolidation range is defined as the last 12 bars where (highest_high −
 * lowest_low) is < 1.4× ATR(14). A breakout = the most recent bar closes
 * outside that range AND its body is > 0.5× ATR.
 */
export function detectRangeBreakout({ candles, pair }) {
  if (!Array.isArray(candles) || candles.length < 20) return null;
  const pipSize = getPipSize(pair);
  const atrPrice = atr(candles, 14);
  if (!atrPrice) return null;

  const rangeWindow = candles.slice(-13, -1); // exclude the breakout candle itself
  if (rangeWindow.length < 10) return null;
  const rangeHigh = Math.max(...rangeWindow.map(c => c.high));
  const rangeLow  = Math.min(...rangeWindow.map(c => c.low));
  const rangeSize = rangeHigh - rangeLow;

  // Only treat as a range if it's actually tight relative to ATR.
  if (rangeSize > atrPrice * 1.4) return null;

  const last = candles[candles.length - 1];
  const body = Math.abs(last.close - last.open);
  if (body < atrPrice * 0.5) return null;        // breakout must be decisive

  if (last.close > rangeHigh) {
    return {
      type: 'range_breakout',
      direction: 'bullish',
      rangeHigh: +rangeHigh.toFixed(pricePrecision(pair)),
      rangeLow:  +rangeLow.toFixed(pricePrecision(pair)),
      rangePips: +(rangeSize / pipSize).toFixed(1),
      reason: `Bullish range breakout: 12-bar range ${(rangeSize/pipSize).toFixed(1)}p (<1.4×ATR) and last bar closed above ${rangeHigh.toFixed(pricePrecision(pair))} with body > 0.5×ATR`,
    };
  }
  if (last.close < rangeLow) {
    return {
      type: 'range_breakout',
      direction: 'bearish',
      rangeHigh: +rangeHigh.toFixed(pricePrecision(pair)),
      rangeLow:  +rangeLow.toFixed(pricePrecision(pair)),
      rangePips: +(rangeSize / pipSize).toFixed(1),
      reason: `Bearish range breakout: 12-bar range ${(rangeSize/pipSize).toFixed(1)}p (<1.4×ATR) and last bar closed below ${rangeLow.toFixed(pricePrecision(pair))} with body > 0.5×ATR`,
    };
  }
  return null;
}

// ─── Detector 6: Retest of broken structure ─────────────────────────────────
/**
 * A retest fires when, after a recent BOS or range breakout (last ~6 bars),
 * price returns to the broken level (within 0.3×ATR) WITHOUT reclaiming it.
 * This is the textbook second-entry institutions look for.
 */
export function detectRetest({ candles, direction, pair }) {
  if (!Array.isArray(candles) || candles.length < 25) return null;
  const atrPrice = atr(candles, 14);
  if (!atrPrice) return null;
  const tolerance = atrPrice * 0.3;

  const { highs, lows } = findPivots(candles.slice(0, -6));
  const last = candles[candles.length - 1];

  if (direction === 'long' && highs.length) {
    const brokenHigh = highs[highs.length - 1].price;
    // Did any of the last 6 bars close above this high? If yes, we BROKE it.
    const broken = candles.slice(-6).some(c => c.close > brokenHigh);
    if (broken) {
      const minLowSinceBreak = Math.min(...candles.slice(-3).map(c => c.low));
      if (Math.abs(minLowSinceBreak - brokenHigh) <= tolerance && last.close > brokenHigh) {
        return {
          type: 'retest',
          direction: 'bullish',
          retestLevel: +brokenHigh.toFixed(pricePrecision(pair)),
          reason: `Bullish retest: price returned to broken high ${brokenHigh.toFixed(pricePrecision(pair))} within 0.3×ATR and held above it`,
        };
      }
    }
  }
  if (direction === 'short' && lows.length) {
    const brokenLow = lows[lows.length - 1].price;
    const broken = candles.slice(-6).some(c => c.close < brokenLow);
    if (broken) {
      const maxHighSinceBreak = Math.max(...candles.slice(-3).map(c => c.high));
      if (Math.abs(maxHighSinceBreak - brokenLow) <= tolerance && last.close < brokenLow) {
        return {
          type: 'retest',
          direction: 'bearish',
          retestLevel: +brokenLow.toFixed(pricePrecision(pair)),
          reason: `Bearish retest: price returned to broken low ${brokenLow.toFixed(pricePrecision(pair))} within 0.3×ATR and held below it`,
        };
      }
    }
  }
  return null;
}

// ─── Detector 7: Wick rejection on last bar ─────────────────────────────────
/**
 * A long lower wick on the last bar suggests buyers stepped in (bullish);
 * a long upper wick suggests sellers (bearish). We require wick > 1.5× body.
 */
export function detectWickRejection({ candles, pair }) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const last = candles[candles.length - 1];
  const body = Math.abs(last.close - last.open);
  if (body === 0) return null;
  const upperWick = last.high - Math.max(last.close, last.open);
  const lowerWick = Math.min(last.close, last.open) - last.low;

  const pipSize = getPipSize(pair);
  if (lowerWick > body * 1.5 && lowerWick > upperWick * 2) {
    return {
      type: 'wick_rejection',
      direction: 'bullish',
      wickPips: +(lowerWick / pipSize).toFixed(1),
      reason: `Bullish wick rejection — lower wick ${(lowerWick/pipSize).toFixed(1)}p > 1.5× body, buyers stepped in`,
    };
  }
  if (upperWick > body * 1.5 && upperWick > lowerWick * 2) {
    return {
      type: 'wick_rejection',
      direction: 'bearish',
      wickPips: +(upperWick / pipSize).toFixed(1),
      reason: `Bearish wick rejection — upper wick ${(upperWick/pipSize).toFixed(1)}p > 1.5× body, sellers stepped in`,
    };
  }
  return null;
}

// ─── Detector 8a: Failed breakout (sweep without follow-through) ────────────
/**
 * Distinct from `detectLiquiditySweep` (which expects an immediate reversal):
 * a "failed breakout" is a candle that closes BEYOND a recent extreme but the
 * very NEXT 1-2 bars fail to push further and close back inside the prior
 * range. Used to disqualify continuation trades after a fake-out.
 */
export function detectFailedBreakout({ candles, pair }) {
  if (!Array.isArray(candles) || candles.length < 20) return null;
  const last = candles[candles.length - 1];
  const breakoutCandles = candles.slice(-5, -1); // 4 candles BEFORE the latest
  const lookback = candles.slice(-25, -5);
  if (!breakoutCandles.length || lookback.length < 10) return null;

  const lookbackHigh = Math.max(...lookback.map(c => c.high));
  const lookbackLow  = Math.min(...lookback.map(c => c.low));

  // Bullish failed: a breakout candle CLOSED above lookbackHigh, but the most
  // recent candle has closed back below it without making a higher high.
  const brokeUp = breakoutCandles.find(c => c.close > lookbackHigh);
  if (brokeUp && last.close < lookbackHigh && last.high <= brokeUp.high) {
    return {
      type: 'liquidity_sweep',     // share the type so the aggregator weights match
      subtype: 'failed_breakout',
      direction: 'bearish',
      brokenLevel: +lookbackHigh.toFixed(pricePrecision(pair)),
      reason: `Failed bullish breakout: prior bar closed above ${lookbackHigh.toFixed(pricePrecision(pair))} but latest closed back below without a new high`,
    };
  }
  const brokeDown = breakoutCandles.find(c => c.close < lookbackLow);
  if (brokeDown && last.close > lookbackLow && last.low >= brokeDown.low) {
    return {
      type: 'liquidity_sweep',
      subtype: 'failed_breakout',
      direction: 'bullish',
      brokenLevel: +lookbackLow.toFixed(pricePrecision(pair)),
      reason: `Failed bearish breakout: prior bar closed below ${lookbackLow.toFixed(pricePrecision(pair))} but latest closed back above without a new low`,
    };
  }
  return null;
}

// ─── Detector 8b: Repeated wick rejection at same zone ──────────────────────
/**
 * Two or more recent candles whose wicks (high for sellers / low for buyers)
 * tested the same level (within 0.4×ATR) and closed back AWAY from it. Strong
 * supply/demand defense — often signals the zone will hold.
 */
export function detectRepeatedWickRejection({ candles, pair }) {
  if (!Array.isArray(candles) || candles.length < 25) return null;
  const atrPrice = atr(candles, 14);
  if (!atrPrice) return null;
  const tolerance = atrPrice * 0.4;
  const recent = candles.slice(-10);

  // Find high-side rejections
  const highRejects = recent.filter(c => {
    const upperWick = c.high - Math.max(c.open, c.close);
    const body = Math.abs(c.close - c.open) || 0.0001;
    return upperWick > body * 1.2;
  });
  if (highRejects.length >= 2) {
    const peaks = highRejects.map(c => c.high);
    const range = Math.max(...peaks) - Math.min(...peaks);
    if (range <= tolerance) {
      const level = peaks.reduce((a, b) => a + b, 0) / peaks.length;
      return {
        type: 'wick_rejection',
        subtype: 'repeated_zone',
        direction: 'bearish',
        rejectionLevel: +level.toFixed(pricePrecision(pair)),
        touches: highRejects.length,
        reason: `${highRejects.length} upper-wick rejections clustered around ${level.toFixed(pricePrecision(pair))} (within 0.4×ATR) — supply zone holding`,
      };
    }
  }
  const lowRejects = recent.filter(c => {
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const body = Math.abs(c.close - c.open) || 0.0001;
    return lowerWick > body * 1.2;
  });
  if (lowRejects.length >= 2) {
    const troughs = lowRejects.map(c => c.low);
    const range = Math.max(...troughs) - Math.min(...troughs);
    if (range <= tolerance) {
      const level = troughs.reduce((a, b) => a + b, 0) / troughs.length;
      return {
        type: 'wick_rejection',
        subtype: 'repeated_zone',
        direction: 'bullish',
        rejectionLevel: +level.toFixed(pricePrecision(pair)),
        touches: lowRejects.length,
        reason: `${lowRejects.length} lower-wick rejections clustered around ${level.toFixed(pricePrecision(pair))} (within 0.4×ATR) — demand zone holding`,
      };
    }
  }
  return null;
}

// ─── Detector 8c: Exhaustion candle after extended move ─────────────────────
/**
 * Large body candle (≥1.2×ATR) printed after 4+ consecutive bars in the same
 * direction. Frequently marks the final flush of a move — taking a
 * continuation entry on this bar typically buys the top / sells the bottom.
 */
export function detectExhaustionCandle({ candles, pair }) {
  if (!Array.isArray(candles) || candles.length < 10) return null;
  const atrPrice = atr(candles, 14);
  if (!atrPrice) return null;
  const last = candles[candles.length - 1];
  const body = Math.abs(last.close - last.open);
  if (body < atrPrice * 1.2) return null;

  // Count consecutive same-color bars BEFORE the latest
  const lastBull = last.close > last.open;
  let runLen = 0;
  for (let i = candles.length - 2; i >= 0; i--) {
    const c = candles[i];
    const cBull = c.close > c.open;
    if (cBull === lastBull) runLen++;
    else break;
  }
  if (runLen < 4) return null;

  return {
    type: 'exhaustion',
    direction: lastBull ? 'bearish' : 'bullish',     // reversal hint: counter to the run
    runLen,
    bodyAtrMultiple: +(body / atrPrice).toFixed(2),
    reason: `Exhaustion candle: body ${(body / atrPrice).toFixed(2)}×ATR after ${runLen} consecutive ${lastBull ? 'bull' : 'bear'} bars`,
  };
}

// ─── Detector 8: ATR expansion after compression ────────────────────────────
/**
 * Current 5-bar ATR vs the prior 15-bar ATR. Expansion = current / prior ≥ 1.4
 * AND the prior window's ATR was actually compressed (≤ 0.8× ATR(28)).
 */
export function detectAtrExpansion({ candles }) {
  if (!Array.isArray(candles) || candles.length < 40) return null;
  const atrRecent  = atr(candles.slice(-6), 5);
  const atrPrior   = atr(candles.slice(-22, -6), 14);
  const atrBaseline= atr(candles.slice(-40), 28);
  if (!atrRecent || !atrPrior || !atrBaseline) return null;

  const wasCompressed = atrPrior / atrBaseline <= 0.85;
  const isExpanding   = atrRecent / atrPrior >= 1.4;
  if (!wasCompressed || !isExpanding) return null;

  // We don't know direction from ATR alone — use the last candle's polarity.
  const last = candles[candles.length - 1];
  const direction = last.close >= last.open ? 'bullish' : 'bearish';
  return {
    type: 'atr_expansion',
    direction,
    atrRatio: +(atrRecent / atrPrior).toFixed(2),
    reason: `ATR expanding ${(atrRecent/atrPrior).toFixed(2)}× after compression — institutional participation likely`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// AGGREGATOR
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Runs all detectors against M15 + H1 (and uses H4 trend as the CHoCH baseline).
 * The aggregator weights signals: liquidity sweep + BOS + CHoCH carry more
 * confidence than a lone FVG or wick rejection.
 *
 * Direction folding:
 *   net = sum(weight × sign) over all detected signals
 *   |net| ≥ 2 → corresponding direction
 *   else      → neutral
 *
 * confidenceImpact:
 *   +20 if direction matches tradeDirection
 *   +5  if neutral
 *   -25 if direction OPPOSES tradeDirection
 */
export function analyzeInstitutionalFlow({
  pair,
  tradeDirection,            // 'long' | 'short' — desired side from waterfall
  m15Candles,
  h1Candles,
  h4Candles,
  priorTrend,                // 'bullish' | 'bearish' — for CHoCH baseline (use H4)
  structureType,             // 'consolidation' | 'trending_*' | …
}) {
  const signals = [];

  // M15 detectors (close-to-entry timing signals)
  if (Array.isArray(m15Candles) && m15Candles.length >= 25) {
    const m15 = m15Candles;
    [
      detectLiquiditySweep({ candles: m15, pair }),
      detectBreakOfStructure({ candles: m15, direction: tradeDirection, pair }),
      detectChangeOfCharacter({ candles: m15, priorTrend, pair }),
      detectFairValueGap({ candles: m15, pair }),
      detectRangeBreakout({ candles: m15, pair }),
      detectRetest({ candles: m15, direction: tradeDirection, pair }),
      detectWickRejection({ candles: m15, pair }),
      detectAtrExpansion({ candles: m15 }),
      detectFailedBreakout({ candles: m15, pair }),
      detectRepeatedWickRejection({ candles: m15, pair }),
      detectExhaustionCandle({ candles: m15, pair }),
    ].forEach(s => { if (s) signals.push({ ...s, timeframe: 'M15' }); });
  }

  // H1 detectors (broader structure signals)
  if (Array.isArray(h1Candles) && h1Candles.length >= 25) {
    const h1 = h1Candles;
    [
      detectBreakOfStructure({ candles: h1, direction: tradeDirection, pair }),
      detectChangeOfCharacter({ candles: h1, priorTrend, pair }),
      detectLiquiditySweep({ candles: h1, pair }),
    ].forEach(s => { if (s) signals.push({ ...s, timeframe: 'H1' }); });
  }

  if (signals.length === 0) {
    return {
      detected: false,
      type: 'none',
      direction: 'neutral',
      confidenceImpact: tradeDirection ? 0 : 0,
      reason: 'No institutional flow proxy fired (no sweep, BOS, CHoCH, FVG, range breakout, retest, wick, or ATR expansion)',
      signals: [],
    };
  }

  // Per-detector weights — sweeps, BOS, CHoCH and confirmed retests carry the
  // most signal. FVG and wick rejection are weaker. ATR expansion is direction-
  // neutral so we count it half-strength.
  const weights = {
    liquidity_sweep:     3,
    break_of_structure:  3,
    choch:               3,
    retest:              3,
    range_breakout:      2,
    imbalance:           1,
    wick_rejection:      1,
    atr_expansion:       1,
    exhaustion:          3,   // counter-trend hint after an extended run
  };
  let net = 0;
  let topWeight = 0;
  let topSignal = signals[0];
  for (const s of signals) {
    const w = weights[s.type] || 1;
    const sign = s.direction === 'bullish' ? 1 : s.direction === 'bearish' ? -1 : 0;
    net += w * sign;
    if (w > topWeight) { topWeight = w; topSignal = s; }
  }

  let direction = 'neutral';
  if (net >= 2) direction = 'bullish';
  else if (net <= -2) direction = 'bearish';

  let confidenceImpact = 0;
  if (tradeDirection) {
    const tradeSign = tradeDirection === 'long' ? 'bullish' : 'bearish';
    if (direction === tradeSign)       confidenceImpact = 20;
    else if (direction === 'neutral')  confidenceImpact = 5;
    else                                confidenceImpact = -25;
  }

  // Consolidation context: if structure type is consolidation and no breakout
  // or retest fired, downgrade confidence further (caller may also reject).
  if (
    structureType === 'consolidation' &&
    !signals.some(s => s.type === 'range_breakout' || s.type === 'retest')
  ) {
    confidenceImpact -= 10;
  }

  const reason =
    `${signals.length} flow signal${signals.length === 1 ? '' : 's'} detected (net=${net}): ` +
    signals.map(s => `${s.timeframe} ${s.type}/${s.direction}`).join(', ') +
    `. Top: ${topSignal.reason}`;

  return {
    detected: true,
    type: topSignal.type,
    direction,
    confidenceImpact,
    reason,
    signals,
    net,
  };
}

void lastN; // exported via tests in the future
