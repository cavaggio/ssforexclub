/**
 * server/oandaIndicators.js
 * Pure technical indicator calculations over OHLCV candle arrays.
 * All functions are stateless and operate on raw number arrays.
 */

/**
 * Simple Moving Average
 */
export function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * Exponential Moving Average
 */
export function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let emVal = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    emVal = values[i] * k + emVal * (1 - k);
  }
  return emVal;
}

/**
 * Returns an array of EMA values (same length as input, nulls at start)
 */
export function emaArray(values, period) {
  const result = new Array(values.length).fill(null);
  if (values.length < period) return result;
  const k = 2 / (period + 1);
  let emVal = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = emVal;
  for (let i = period; i < values.length; i++) {
    emVal = values[i] * k + emVal * (1 - k);
    result[i] = emVal;
  }
  return result;
}

/**
 * RSI (Relative Strength Index)
 */
export function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const relevant = closes.slice(-(period + 10));
  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = relevant[i] - relevant[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < relevant.length; i++) {
    const diff = relevant[i] - relevant[i - 1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * MACD: returns { macd, signal, histogram }
 */
export function macd(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (closes.length < slowPeriod + signalPeriod) return null;

  const fastEma = emaArray(closes, fastPeriod);
  const slowEma = emaArray(closes, slowPeriod);

  const macdLine = closes.map((_, i) => {
    if (fastEma[i] === null || slowEma[i] === null) return null;
    return fastEma[i] - slowEma[i];
  });

  const validMacd = macdLine.filter((v) => v !== null);
  if (validMacd.length < signalPeriod) return null;

  const signalLine = emaArray(validMacd, signalPeriod);
  const lastMacd = validMacd[validMacd.length - 1];
  const lastSignal = signalLine[signalLine.length - 1];

  return {
    macd: lastMacd,
    signal: lastSignal,
    histogram: lastMacd - lastSignal,
  };
}

/**
 * ATR (Average True Range)
 */
export function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const relevant = candles.slice(-(period + 1));
  const trValues = [];

  for (let i = 1; i < relevant.length; i++) {
    const h = relevant[i].high;
    const l = relevant[i].low;
    const pc = relevant[i - 1].close;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    trValues.push(tr);
  }

  return trValues.reduce((a, b) => a + b, 0) / trValues.length;
}

/**
 * Detect trend direction based on price vs EMAs.
 * Returns 'bullish' | 'bearish' | 'neutral'.
 *
 * Loosened from the original strict `current > ema20 > ema50` check so a
 * routine pullback into the 20-EMA on an otherwise healthy trend doesn't
 * flip the classification to neutral. The rule is now:
 *
 *   • EMA20 > EMA50 AND (price > EMA50 OR slope-of-EMA20 is rising) → bullish
 *   • EMA20 < EMA50 AND (price < EMA50 OR slope-of-EMA20 is falling) → bearish
 *   • otherwise → neutral
 *
 * The slope check uses an EMA20 from 5 bars ago vs the current EMA20: this
 * keeps trends labeled correctly through short pullbacks but reverts to
 * neutral when the structure actually breaks.
 */
export function detectTrend(closes) {
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  if (!ema20 || !ema50) return 'neutral';

  const current = closes[closes.length - 1];

  // Slope of EMA20 over the last 5 bars (skip the most recent for stability).
  let ema20Past = null;
  if (closes.length >= 25) {
    ema20Past = ema(closes.slice(0, -5), 20);
  }
  const slopeRising  = ema20Past !== null && ema20 > ema20Past;
  const slopeFalling = ema20Past !== null && ema20 < ema20Past;

  // EMA structure is the primary signal; price-vs-EMA50 OR slope confirms.
  if (ema20 > ema50 && (current > ema50 || slopeRising))  return 'bullish';
  if (ema20 < ema50 && (current < ema50 || slopeFalling)) return 'bearish';
  return 'neutral';
}

/**
 * Check EMA alignment: fast > slow = bullish alignment
 * Returns 'aligned_bullish' | 'aligned_bearish' | 'mixed'
 */
export function emaAlignment(closes) {
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);
  const ema50val = ema(closes, 50);

  if (!ema8 || !ema21 || !ema50val) return 'mixed';
  if (ema8 > ema21 && ema21 > ema50val) return 'aligned_bullish';
  if (ema8 < ema21 && ema21 < ema50val) return 'aligned_bearish';
  return 'mixed';
}

/**
 * Detect support/resistance proximity.
 * Returns how many pips price is from recent S/R level.
 */
export function srProximity(candles, pipSize = 0.0001) {
  if (candles.length < 20) return null;
  const recent = candles.slice(-20);
  const highs = recent.map((c) => c.high);
  const lows = recent.map((c) => c.low);
  const current = candles[candles.length - 1].close;

  const nearestResistance = Math.min(...highs.filter((h) => h > current));
  const nearestSupport = Math.max(...lows.filter((l) => l < current));

  const distToResistance = (nearestResistance - current) / pipSize;
  const distToSupport = (current - nearestSupport) / pipSize;

  return {
    nearestResistance,
    nearestSupport,
    distToResistancePips: +distToResistance.toFixed(1),
    distToSupportPips: +distToSupport.toFixed(1),
  };
}

/**
 * Candle confirmation: check if last candle is bullish/bearish/doji
 */
export function candleConfirmation(candles) {
  if (candles.length < 2) return 'unknown';
  const last = candles[candles.length - 1];
  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low;

  if (range === 0) return 'doji';
  const bodyRatio = body / range;

  if (bodyRatio < 0.2) return 'doji';
  if (last.close > last.open) return 'bullish';
  return 'bearish';
}
