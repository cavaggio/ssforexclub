/**
 * server/oandaFibonacci.js
 *
 * Fibonacci retracement layer for the institutional waterfall.
 *
 *   detectFibSetup({ direction, h1Candles, currentPrice, pair })
 *
 * Identifies the most recent directional IMPULSE on H1 and computes
 * 38.2 / 50 / 61.8 / 78.6 retracement levels. H4 remains macro context in
 * the scanner and is intentionally excluded from Fib swing selection,
 * retracement percentage, level calculation, and breakout confirmation.
 *
 * Definitions:
 *   "impulse"  — a directional leg from swing low → swing high (bullish) or
 *                swing high → swing low (bearish), at least
 *                MIN_IMPULSE_ATR_MULTIPLE × H1 ATR in size.
 *   "entry zone" — the 38.2 ↔ 78.6 retracement band of the H1 impulse.
 *
 * Returned object — wired directly onto the signal:
 *   {
 *     enabled: true,
 *     timeframeUsed: 'H1',
 *     swingHigh, swingLow,
 *     impulsePips, impulseAtrMultiple,
 *     retracementLevels: { level382, level500, level618, level786 },
 *     currentPrice,
 *     entryZone: { lower, upper },
 *     entryZoneStatus: 'inside_zone' | 'too_early' | 'extended' |
 *                      'breakout_confirmed' | 'invalidated',
 *     pctRetraced,
 *     reason
 *   }
 */

import { atr } from './oandaIndicators.js';

const MIN_IMPULSE_ATR_MULTIPLE = 1.2;
const SWING_PIVOT_LOOKBACK = 3;
const IMPULSE_SEARCH_BARS = 40;

function getPipSize(pair) {
  if (String(pair || '').includes('JPY')) return 0.01;
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return 0.01;
  return 0.0001;
}

function pricePrecision(pair) {
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return 2;
  if (String(pair || '').includes('JPY')) return 3;
  return 5;
}

function findPivots(candles, lookback = SWING_PIVOT_LOOKBACK) {
  const highs = [];
  const lows = [];
  if (!Array.isArray(candles) || candles.length < lookback * 2 + 1) {
    return { highs, lows };
  }

  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: candles[i].high });
    if (isLow) lows.push({ index: i, price: candles[i].low });
  }
  return { highs, lows };
}

function findBullishImpulse(candles, atrPriceUnits) {
  const slice = candles.slice(-IMPULSE_SEARCH_BARS);
  const offset = candles.length - slice.length;
  const { highs, lows } = findPivots(slice);
  if (!highs.length || !lows.length) return null;

  for (let i = highs.length - 1; i >= 0; i--) {
    const hi = highs[i];
    let bestLow = null;
    for (let j = lows.length - 1; j >= 0; j--) {
      if (lows[j].index < hi.index && lows[j].price < hi.price) {
        bestLow = lows[j];
        break;
      }
    }
    if (!bestLow) continue;
    const impulse = hi.price - bestLow.price;
    if (atrPriceUnits && impulse < atrPriceUnits * MIN_IMPULSE_ATR_MULTIPLE) continue;
    return {
      swingLow: bestLow.price,
      swingHigh: hi.price,
      lowIndex: bestLow.index + offset,
      highIndex: hi.index + offset,
      impulse,
    };
  }
  return null;
}

function findBearishImpulse(candles, atrPriceUnits) {
  const slice = candles.slice(-IMPULSE_SEARCH_BARS);
  const offset = candles.length - slice.length;
  const { highs, lows } = findPivots(slice);
  if (!highs.length || !lows.length) return null;

  for (let i = lows.length - 1; i >= 0; i--) {
    const lo = lows[i];
    let bestHigh = null;
    for (let j = highs.length - 1; j >= 0; j--) {
      if (highs[j].index < lo.index && highs[j].price > lo.price) {
        bestHigh = highs[j];
        break;
      }
    }
    if (!bestHigh) continue;
    const impulse = bestHigh.price - lo.price;
    if (atrPriceUnits && impulse < atrPriceUnits * MIN_IMPULSE_ATR_MULTIPLE) continue;
    return {
      swingHigh: bestHigh.price,
      swingLow: lo.price,
      highIndex: bestHigh.index + offset,
      lowIndex: lo.index + offset,
      impulse,
    };
  }
  return null;
}

function computeBullishLevels({ swingHigh, swingLow }) {
  const range = swingHigh - swingLow;
  return {
    level382: swingHigh - range * 0.382,
    level500: swingHigh - range * 0.500,
    level618: swingHigh - range * 0.618,
    level786: swingHigh - range * 0.786,
  };
}

function computeBearishLevels({ swingHigh, swingLow }) {
  const range = swingHigh - swingLow;
  return {
    level382: swingLow + range * 0.382,
    level500: swingLow + range * 0.500,
    level618: swingLow + range * 0.618,
    level786: swingLow + range * 0.786,
  };
}

function isBreakoutConfirmed({ candles, swingHigh, swingLow, direction }) {
  if (!Array.isArray(candles) || candles.length < 2) return false;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  if (direction === 'long') {
    return last.close > swingHigh && prev.close > swingHigh;
  }
  return last.close < swingLow && prev.close < swingLow;
}

function pickImpulse({ direction, h1Candles, pair }) {
  const pipSize = getPipSize(pair);
  const atrH1Price = Array.isArray(h1Candles) && h1Candles.length >= 20
    ? atr(h1Candles, 14)
    : null;

  if (!Array.isArray(h1Candles) || h1Candles.length < 20 || !atrH1Price) {
    return {
      impulse: null,
      timeframeUsed: null,
      candles: null,
      atrPriceUnits: null,
      pipSize,
    };
  }

  const impulse = direction === 'long'
    ? findBullishImpulse(h1Candles, atrH1Price)
    : findBearishImpulse(h1Candles, atrH1Price);

  return {
    impulse,
    timeframeUsed: impulse ? 'H1' : null,
    candles: impulse ? h1Candles : null,
    atrPriceUnits: impulse ? atrH1Price : null,
    pipSize,
  };
}

export function detectFibSetup({ direction, h1Candles, currentPrice, pair }) {
  if (direction !== 'long' && direction !== 'short') {
    return {
      enabled: false,
      reason: 'No direction supplied — fib analysis skipped',
    };
  }

  const { impulse, timeframeUsed, candles, atrPriceUnits, pipSize } =
    pickImpulse({ direction, h1Candles, pair });

  if (!impulse) {
    return {
      enabled: true,
      timeframeUsed: null,
      reason: 'No clean H1 impulse leg found (min 1.2×ATR) — fib zone undetermined',
      entryZoneStatus: 'unknown',
    };
  }

  const { swingHigh, swingLow } = impulse;
  const impulseRange = swingHigh - swingLow;
  const impulsePips = +(impulseRange / pipSize).toFixed(1);
  const impulseAtrMultiple = atrPriceUnits
    ? +(impulseRange / atrPriceUnits).toFixed(2)
    : null;

  const levels = direction === 'long'
    ? computeBullishLevels({ swingHigh, swingLow })
    : computeBearishLevels({ swingHigh, swingLow });

  const pctRetraced = direction === 'long'
    ? (swingHigh - currentPrice) / impulseRange
    : (currentPrice - swingLow) / impulseRange;

  const entryZone = direction === 'long'
    ? { lower: levels.level786, upper: levels.level382 }
    : { lower: levels.level382, upper: levels.level786 };

  const insideZone =
    currentPrice >= Math.min(entryZone.lower, entryZone.upper) &&
    currentPrice <= Math.max(entryZone.lower, entryZone.upper);

  const breakoutConfirmed = isBreakoutConfirmed({
    candles,
    swingHigh,
    swingLow,
    direction,
  });

  let entryZoneStatus;
  let reason;

  if (direction === 'long') {
    if (currentPrice > swingHigh) {
      entryZoneStatus = breakoutConfirmed ? 'breakout_confirmed' : 'extended';
      reason = breakoutConfirmed
        ? `Price closed above impulse high ${swingHigh.toFixed(pricePrecision(pair))} for 2 H1 bars — breakout confirmed`
        : `Price has pushed above impulse high ${swingHigh.toFixed(pricePrecision(pair))} without 2-bar H1 confirmation — risk of failed breakout / late entry`;
    } else if (currentPrice < swingLow) {
      entryZoneStatus = 'invalidated';
      reason = `Price has traded below the impulse origin ${swingLow.toFixed(pricePrecision(pair))} — bullish H1 impulse invalidated`;
    } else if (insideZone) {
      entryZoneStatus = 'inside_zone';
      reason = `Price inside ${(pctRetraced * 100).toFixed(0)}% retracement of H1 impulse (${impulsePips}p) — healthy pullback entry`;
    } else if (pctRetraced < 0.382) {
      entryZoneStatus = 'too_early';
      reason = `Price only ${(pctRetraced * 100).toFixed(0)}% retraced (< 38.2%) — not yet inside H1 entry zone`;
    } else {
      entryZoneStatus = 'extended';
      reason = 'Price > 78.6% retraced — deep H1 retracement, treat as near-invalidation rather than entry';
    }
  } else if (currentPrice < swingLow) {
    entryZoneStatus = breakoutConfirmed ? 'breakout_confirmed' : 'extended';
    reason = breakoutConfirmed
      ? `Price closed below impulse low ${swingLow.toFixed(pricePrecision(pair))} for 2 H1 bars — breakdown confirmed`
      : `Price has dropped below impulse low ${swingLow.toFixed(pricePrecision(pair))} without 2-bar H1 confirmation — risk of failed breakdown / late entry`;
  } else if (currentPrice > swingHigh) {
    entryZoneStatus = 'invalidated';
    reason = `Price has traded above the impulse origin ${swingHigh.toFixed(pricePrecision(pair))} — bearish H1 impulse invalidated`;
  } else if (insideZone) {
    entryZoneStatus = 'inside_zone';
    reason = `Price inside ${(pctRetraced * 100).toFixed(0)}% retracement of H1 impulse (${impulsePips}p) — healthy pullback entry`;
  } else if (pctRetraced < 0.382) {
    entryZoneStatus = 'too_early';
    reason = `Price only ${(pctRetraced * 100).toFixed(0)}% retraced (< 38.2%) — not yet inside H1 entry zone`;
  } else {
    entryZoneStatus = 'extended';
    reason = 'Price > 78.6% retraced — deep H1 retracement, treat as near-invalidation rather than entry';
  }

  const prec = pricePrecision(pair);
  const round = (n) => Number(n.toFixed(prec));

  return {
    enabled: true,
    timeframeUsed,
    swingHigh: round(swingHigh),
    swingLow: round(swingLow),
    impulsePips,
    impulseAtrMultiple,
    retracementLevels: {
      level382: round(levels.level382),
      level500: round(levels.level500),
      level618: round(levels.level618),
      level786: round(levels.level786),
    },
    currentPrice: round(currentPrice),
    entryZone: {
      lower: round(entryZone.lower),
      upper: round(entryZone.upper),
    },
    entryZoneStatus,
    pctRetraced: Number.isFinite(pctRetraced) ? +pctRetraced.toFixed(3) : null,
    breakoutConfirmed,
    reason,
  };
}
