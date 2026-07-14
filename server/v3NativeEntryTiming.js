import { classifyEntryTiming } from './oandaEntryTiming.js';

function pipSize(pair = '') {
  return String(pair).includes('JPY') ? 0.01 : 0.0001;
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function alignedSign(direction) {
  return direction === 'long' ? 'bullish' : direction === 'short' ? 'bearish' : null;
}

/**
 * Detect a recent M15 retest of the broken impulse level. A retest is counted
 * only when price touches within roughly 0.3 ATR and closes back on the correct
 * side of the level. This is intentionally confirmation-only; it never creates
 * a direction or overrides the V3 alignment/quality gates.
 */
export function detectV3NativeRetest({ direction, fibonacci, m15Candles = [], atrPips, pair } = {}) {
  if (fibonacci?.entryZoneStatus !== 'breakout_confirmed') return null;

  const level = finite(direction === 'long' ? fibonacci.swingHigh : fibonacci.swingLow);
  if (level === null) return null;

  const tolerancePips = Math.max(1.5, (finite(atrPips) ?? 10) * 0.3);
  const tolerance = tolerancePips * pipSize(pair);
  const recent = m15Candles.slice(-6);

  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const candle = recent[index] || {};
    const high = finite(candle.high);
    const low = finite(candle.low);
    const close = finite(candle.close);
    if (high === null || low === null || close === null) continue;

    if (direction === 'long') {
      const touched = low <= level + tolerance && high >= level - tolerance;
      const held = close >= level;
      if (touched && held) {
        return {
          type: 'retest',
          direction: 'bullish',
          timeframe: 'M15',
          level,
          tolerancePips: +tolerancePips.toFixed(2),
          candleIndexFromLatest: recent.length - 1 - index,
        };
      }
    }

    if (direction === 'short') {
      const touched = high >= level - tolerance && low <= level + tolerance;
      const held = close <= level;
      if (touched && held) {
        return {
          type: 'retest',
          direction: 'bearish',
          timeframe: 'M15',
          level,
          tolerancePips: +tolerancePips.toFixed(2),
          candleIndexFromLatest: recent.length - 1 - index,
        };
      }
    }
  }

  return null;
}

/**
 * V3-owned entry timing. It reuses the audited timing policy, but supplies only
 * V3-native inputs and a directly detected M15 retest. No legacy scanner result
 * or legacy qualified/rejected array is consumed.
 */
export function classifyV3NativeEntryTiming({
  direction,
  fibonacci,
  v3,
  m15Candles = [],
  atrPips,
  newsRisk,
  currentPrice,
  pair,
} = {}) {
  const retest = detectV3NativeRetest({ direction, fibonacci, m15Candles, atrPips, pair });
  const sign = alignedSign(direction);
  const signals = [];

  if (retest) signals.push(retest);
  if (v3?.structure?.bosDetected === true) {
    signals.push({
      type: 'break_of_structure',
      direction: v3.structure?.bos?.direction || sign,
      timeframe: 'V3',
    });
  }
  if (v3?.structure?.chochDetected === true) {
    signals.push({
      type: 'change_of_character',
      direction: v3.structure?.choch?.direction || sign,
      timeframe: 'V3',
    });
  }
  if (v3?.liquidity?.liquiditySweepDetected === true) {
    signals.push({
      type: 'liquidity_sweep',
      direction: v3.liquidity?.liquiditySweep?.direction || sign,
      timeframe: 'V3',
    });
  }

  const timing = classifyEntryTiming({
    direction,
    fibonacci,
    institutionalFlow: {
      direction: sign || 'neutral',
      type: retest ? 'retest' : signals[0]?.type || 'v3_native',
      signals,
    },
    structure: v3?.structure || null,
    momentum: null,
    newsRisk,
    currentPrice,
    pair,
  });

  return {
    ...timing,
    source: 'v3_native',
    retestDetected: Boolean(retest),
    retest,
  };
}
