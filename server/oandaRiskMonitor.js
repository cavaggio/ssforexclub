/**
 * server/oandaRiskMonitor.js
 * Pre-trade and pre-scan risk checks beyond the 9 guards in oandaTrade.js.
 * Detects unsafe market conditions: spread spikes, ATR explosions,
 * over-extended candles, and price over-extension from EMA.
 */

import { ema } from './oandaIndicators.js';

const ATR_SPIKE_MULTIPLIER = parseFloat(process.env.FOREX_ATR_SPIKE_MULTIPLIER || '2.5');
const MAX_CANDLE_BODY_RATIO = parseFloat(process.env.FOREX_MAX_CANDLE_BODY_RATIO || '0.85');
const MAX_EMA_DEVIATION_ATR = parseFloat(process.env.FOREX_MAX_EMA_DEVIATION_ATR || '3.0');
const SPREAD_SPIKE_MULTIPLIER = parseFloat(process.env.FOREX_SPREAD_SPIKE_MULTIPLIER || '3.5');

/**
 * ATR spike: current 14-period ATR vs historical 28-period baseline.
 */
export function isAtrSpiking(candles) {
  if (candles.length < 42) return false;
  const recentCandles = candles.slice(-14);
  const baselineCandles = candles.slice(-42, -14);
  const avgRange = (cs) => cs.reduce((sum, c) => sum + (c.high - c.low), 0) / cs.length;
  const recent = avgRange(recentCandles);
  const baseline = avgRange(baselineCandles);
  return baseline > 0 && recent > baseline * ATR_SPIKE_MULTIPLIER;
}

/**
 * Over-extended candle body: body:range ratio above threshold (exhaustion signal).
 */
export function isCandleOverextended(candle) {
  const DISABLE_EXHAUSTION =
    process.env.FOREX_DISABLE_EXHAUSTION_FILTER === 'true';

  if (DISABLE_EXHAUSTION) return false;

  const body = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low;

  if (range === 0) return false;

  return body / range > MAX_CANDLE_BODY_RATIO;
}

/**
 * Price over-extension from EMA20 (in ATR units).
 */
export function isPriceOverextended(closes, atrValue) {
  if (!atrValue || atrValue <= 0 || closes.length < 20) return false;
  const ema20 = ema(closes, 20);
  if (!ema20) return false;
  const deviation = Math.abs(closes[closes.length - 1] - ema20);
  return deviation > atrValue * MAX_EMA_DEVIATION_ATR;
}

/**
 * Spread widening: current spread vs the pair's expected baseline spread.
 */
export function isSpreadWidened(currentSpreadPips, baselineSpreadPips) {
  if (!baselineSpreadPips || baselineSpreadPips <= 0) return false;
  return currentSpreadPips > baselineSpreadPips * SPREAD_SPIKE_MULTIPLIER;
}

/**
 * Calculate the typical spread for a pair from recent pricing samples.
 * For now returns the pair's known normal spread — in production, track a rolling average.
 */
const TYPICAL_SPREADS = {
  EUR_USD: 0.8, GBP_USD: 1.0, USD_JPY: 0.8, USD_CHF: 1.0,
  AUD_USD: 0.9, USD_CAD: 1.0, NZD_USD: 1.2,
  EUR_GBP: 1.0, EUR_JPY: 1.0, GBP_JPY: 1.5,
  AUD_JPY: 1.2, EUR_AUD: 1.5, GBP_AUD: 1.8,
  XAU_USD: 35,  // Gold: ~$0.35 spread = 35 pips at pip=0.01
  XAG_USD: 30,  // Silver: ~$0.30 spread = 30 pips at pip=0.01
};

export function getTypicalSpread(pair) {
  return TYPICAL_SPREADS[pair] || 1.5;
}

/**
 * Run all pre-trade risk checks for a signal.
 * @returns {{ safe: boolean, reason: string | null, checks: object }}
 */
export function checkMarketConditions({ pair, candles, currentSpreadPips, atrValue, closes }) {
  const baselineSpread = getTypicalSpread(pair);
  const checks = {};

  checks.spreadOk = !isSpreadWidened(currentSpreadPips, baselineSpread);
  if (!checks.spreadOk) {
    return {
      safe: false,
      reason: `Spread widened to ${currentSpreadPips.toFixed(2)} pips (typical: ${baselineSpread} pips)`,
      checks,
    };
  }

  checks.atrOk = !isAtrSpiking(candles);
  if (!checks.atrOk) {
    return {
      safe: false,
      reason: 'ATR spike detected — volatility is abnormally high for safe entry',
      checks,
    };
  }

  if (candles.length > 0) {
    checks.candleOk = !isCandleOverextended(candles[candles.length - 1]);
    if (!checks.candleOk) {
      return {
        safe: false,
        reason: 'Last candle body is over-extended — possible exhaustion, avoid chasing',
        checks,
      };
    }
  }

  checks.priceOk = !isPriceOverextended(closes, atrValue);
  if (!checks.priceOk) {
    return {
      safe: false,
      reason: `Price is over-extended from EMA by more than ${MAX_EMA_DEVIATION_ATR}× ATR`,
      checks,
    };
  }

  return { safe: true, reason: null, checks };
}
