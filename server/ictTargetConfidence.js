import { getPipSize } from './pipMath.js';

const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, value));
const finite = (value, fallback = null) => {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * ICT confidence is the confidence that the CURRENT executable entry reaches the
 * recorded target before the recorded stop. It is intentionally not the raw
 * number of ICT concepts detected.
 *
 * The weakest execution dimension caps the result. A strong higher-timeframe
 * narrative therefore cannot hide a stale trigger, a late market entry, poor
 * executable R:R, an already-consumed move, or a synthetic target extension.
 */
export function computeIctTargetHitConfidence({
  confluenceScore = 0,
  freshImpulse = false,
  triggerAgeBars = null,
  entryDriftAtr = null,
  rewardConsumedFraction = 0,
  priceInsideEntryZone = true,
  actualRR = 0,
  minimumRR = 1.5,
  targetAdjusted = false,
  spreadPips = null,
  maxSpreadPips = 3.5,
  minConfidence = 93,
} = {}) {
  const confluence = clamp(finite(confluenceScore, 0));
  const age = finite(triggerAgeBars);
  const drift = Math.max(0, finite(entryDriftAtr, 99));
  const consumed = clamp(finite(rewardConsumedFraction, 0), 0, 1.5);
  const rr = Math.max(0, finite(actualRR, 0));
  const rrFloor = Math.max(1.5, finite(minimumRR, 1.5));
  const spread = Math.max(0, finite(spreadPips, 0));
  const spreadLimit = Math.max(0.1, finite(maxSpreadPips, 3.5));

  let timingScore = 100;
  if (!freshImpulse) timingScore -= 40;
  if (age == null) timingScore -= 25;
  else if (age > 1) timingScore -= Math.min(35, (age - 1) * 15);

  if (drift > 0.15) timingScore -= Math.min(45, (drift - 0.15) * 55);
  if (consumed > 0.08) timingScore -= Math.min(45, (consumed - 0.08) * 95);
  if (!priceInsideEntryZone) timingScore -= 35;
  timingScore = clamp(timingScore);

  let geometryScore = 100;
  if (rr < rrFloor) geometryScore = 0;
  else if (rr < rrFloor + 0.15) geometryScore -= 5;
  if (spread > spreadLimit * 0.5) {
    geometryScore -= Math.min(35, ((spread / spreadLimit) - 0.5) * 50);
  }
  if (spread > spreadLimit) geometryScore = 0;
  geometryScore = clamp(geometryScore);

  const weighted = (confluence * 0.75) + (geometryScore * 0.25);
  const confidence = Math.round(clamp(Math.min(weighted, geometryScore, confluence)));

  const blockers = [];
  if (rr < rrFloor) blockers.push(`executable R:R ${rr.toFixed(2)} is below ${rrFloor.toFixed(2)}`);
  if (spread > spreadLimit) blockers.push(`spread ${spread.toFixed(1)}p exceeds ${spreadLimit.toFixed(1)}p`);
  if (confidence < minConfidence) blockers.push(`target-hit confidence ${confidence}% is below ${minConfidence}%`);

  return {
    confidence,
    targetHitConfidence: confidence,
    confluenceScore: Math.round(confluence),
    timingScore: Math.round(timingScore),
    geometryScore: Math.round(geometryScore),
    freshImpulse: Boolean(freshImpulse),
    triggerAgeBars: age,
    entryDriftAtr: +drift.toFixed(3),
    rewardConsumedFraction: +consumed.toFixed(3),
    priceInsideEntryZone: Boolean(priceInsideEntryZone),
    actualRR: +rr.toFixed(2),
    minimumRR: rrFloor,
    targetAdjusted: Boolean(targetAdjusted),
    spreadPips: +spread.toFixed(2),
    eligible: blockers.length === 0,
    blockers,
    model: 'ict_current_executable_scalp_v2',
  };
}

/**
 * Reprices the target-hit model against the fresh bid/ask used for a market
 * order. This is the final execution confirmation; scanner confidence alone is
 * never sufficient for a live/practice fill.
 */
export function repriceIctTargetHitConfidence({
  analysis = {},
  pair,
  direction,
  executablePrice,
  spreadPips = null,
  maxSpreadPips = 3.5,
  minConfidence = 93,
} = {}) {
  const entry = finite(executablePrice);
  const stop = finite(analysis.stopLoss);
  const target = finite(analysis.target1 ?? analysis.takeProfit);
  const idealEntry = finite(analysis.idealEntry, finite(analysis.entry));
  const zoneLow = finite(analysis.entryZoneLow);
  const zoneHigh = finite(analysis.entryZoneHigh);
  const atrPips = Math.max(0, finite(analysis.atrPips, 0));
  const pip = getPipSize(pair);
  const atrPrice = atrPips > 0 ? atrPips * pip : null;
  const isLong = direction === 'long' || direction === 'buy';

  const validGeometry = [entry, stop, target].every(Number.isFinite) && (
    isLong ? stop < entry && target > entry : stop > entry && target < entry
  );
  const risk = validGeometry ? Math.abs(entry - stop) : 0;
  const reward = validGeometry ? Math.abs(target - entry) : 0;
  const actualRR = risk > 0 ? reward / risk : 0;
  const entryDriftAtr = atrPrice && Number.isFinite(idealEntry)
    ? Math.abs(entry - idealEntry) / atrPrice
    : 99;
  const totalMove = Number.isFinite(idealEntry) && Number.isFinite(target)
    ? Math.abs(target - idealEntry)
    : 0;
  const consumedMove = Number.isFinite(idealEntry)
    ? Math.max(0, isLong ? entry - idealEntry : idealEntry - entry)
    : 0;
  const rewardConsumedFraction = totalMove > 0 ? consumedMove / totalMove : 1;
  const zoneTolerance = atrPrice ? atrPrice * 0.10 : 0;
  const priceInsideEntryZone = Number.isFinite(zoneLow) && Number.isFinite(zoneHigh)
    ? entry >= Math.min(zoneLow, zoneHigh) - zoneTolerance && entry <= Math.max(zoneLow, zoneHigh) + zoneTolerance
    : analysis.entrySource === 'MARKET';

  return computeIctTargetHitConfidence({
    confluenceScore: analysis.confluenceScore ?? analysis.targetConfidence?.confluenceScore ?? analysis.confidence,
    freshImpulse: analysis.freshImpulse ?? analysis.targetConfidence?.freshImpulse,
    triggerAgeBars: analysis.triggerAgeBars ?? analysis.targetConfidence?.triggerAgeBars,
    entryDriftAtr,
    rewardConsumedFraction,
    priceInsideEntryZone,
    actualRR,
    minimumRR: analysis.minimumRR ?? analysis.targetConfidence?.minimumRR ?? 1.5,
    targetAdjusted: analysis.targetAdjustedToMinRR ?? analysis.targetConfidence?.targetAdjusted,
    spreadPips,
    maxSpreadPips,
    minConfidence,
  });
}

export function ictProbabilitiesFromConfidence(confidence) {
  const tpPercent = Math.round(clamp(finite(confidence, 0)));
  return {
    tpProbability: tpPercent / 100,
    slProbability: (100 - tpPercent) / 100,
  };
}
