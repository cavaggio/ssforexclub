/**
 * ICT concept facade with Daily-specific directional hierarchy.
 * Legacy detectors remain unchanged in ictConceptsLegacy.js.
 */
export * from './ictConceptsLegacy.js';
import * as legacy from './ictConceptsLegacy.js';
import { computeDailyStructure } from './ictDailyStructure.js';

function looksLikeDaily(candles) {
  if (!Array.isArray(candles) || candles.length < 3) return false;
  const times = candles.filter((c) => c?.complete !== false && c?.time).slice(-7)
    .map((c) => Date.parse(c.time)).filter(Number.isFinite);
  if (times.length < 3) return false;
  const diffs = [];
  for (let i = 1; i < times.length; i += 1) {
    const delta = Math.abs(times[i] - times[i - 1]);
    if (delta > 0) diffs.push(delta);
  }
  if (!diffs.length) return false;
  diffs.sort((a, b) => a - b);
  const median = diffs[Math.floor(diffs.length / 2)];
  return median >= 20 * 60 * 60 * 1000 && median <= 30 * 60 * 60 * 1000;
}

export function htfBias(candles, lookback = 20) {
  if (looksLikeDaily(candles)) {
    return computeDailyStructure({ dailyCandles: candles }).dailyBias;
  }
  return legacy.htfBias(candles, lookback);
}

export function computeDailyBias(args = {}) {
  const legacyResult = legacy.computeDailyBias(args);
  const dailyStructure = computeDailyStructure({
    dailyCandles: args.dailyCandles,
    currentPrice: args.currentPrice,
  });
  return {
    ...legacyResult,
    dailyBias: dailyStructure.dailyBias,
    activeBias: dailyStructure.activeBias,
    contextBias: dailyStructure.contextBias,
    recencyBias: dailyStructure.recencyBias,
    dailyStructure,
    reason: dailyStructure.reason,
  };
}
