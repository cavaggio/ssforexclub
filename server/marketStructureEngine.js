/**
 * server/marketStructureEngine.js
 *
 * Signal Stack V3 — Market Structure Engine (priority #2, above EMA).
 *
 *   analyzeMarketStructure({ pair, h4Candles, m15Candles })
 *
 * Market structure is evaluated from M15 execution structure, with H4 as the
 * fallback when M15 data is unavailable. H1 is intentionally excluded because
 * it is reserved for Fibonacci impulse and retracement analysis.
 *
 * Replaces heavy EMA dependence with pure price structure: the sequence of
 * Higher Highs / Higher Lows / Lower Highs / Lower Lows, plus Break of
 * Structure (BOS) and Change of Character (CHoCH). EMA stays informational in
 * the V3 model; structure carries the weight here.
 *
 * Reuses the production detectBreakOfStructure() / detectChangeOfCharacter()
 * from oandaInstitutionalFlow.js rather than re-deriving them.
 */

import { detectBreakOfStructure, detectChangeOfCharacter } from './oandaInstitutionalFlow.js';

const SWING_LOOKBACK = 2;

function findPivots(candles, lookback = SWING_LOOKBACK) {
  const pivots = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) pivots.push({ index: i, price: candles[i].high, kind: 'high' });
    if (isLow) pivots.push({ index: i, price: candles[i].low, kind: 'low' });
  }
  return pivots.sort((a, b) => a.index - b.index);
}

/** Label each pivot relative to the prior same-kind pivot (HH/HL/LH/LL). */
function labelSwings(pivots) {
  let lastHigh = null, lastLow = null;
  return pivots.map((p) => {
    let label = null;
    if (p.kind === 'high') {
      if (lastHigh != null) label = p.price > lastHigh ? 'HH' : 'LH';
      lastHigh = p.price;
    } else {
      if (lastLow != null) label = p.price > lastLow ? 'HL' : 'LL';
      lastLow = p.price;
    }
    return { ...p, label };
  });
}

function classifyTrend(swings) {
  const labels = swings.map((s) => s.label).filter(Boolean);
  const recent = labels.slice(-4);
  const hasHH = recent.includes('HH');
  const hasHL = recent.includes('HL');
  const hasLH = recent.includes('LH');
  const hasLL = recent.includes('LL');
  if (hasHH && hasHL && !hasLL) return 'bullish';
  if (hasLL && hasLH && !hasHH) return 'bearish';
  if (hasHH && hasHL) return 'bullish';
  if (hasLL && hasLH) return 'bearish';
  return 'ranging';
}

export function analyzeMarketStructure({ pair, h4Candles = [], m15Candles = [] } = {}) {
  const reasons = [];
  const useM15 = Array.isArray(m15Candles) && m15Candles.length >= 20;
  const base = useM15 ? m15Candles : h4Candles;
  const timeframeUsed = useM15 ? 'M15' : (Array.isArray(h4Candles) && h4Candles.length >= 20 ? 'H4' : null);

  if (!Array.isArray(base) || base.length < 20) {
    return {
      structureTrend: 'ranging',
      bosDetected: false, bos: null,
      chochDetected: false, choch: null,
      lastStructureBreak: null,
      structureStrength: 0,
      swings: [],
      timeframeUsed: null,
      h1Used: false,
      reasons: ['Insufficient M15/H4 candles for structure analysis.'],
    };
  }

  const swings = labelSwings(findPivots(base));
  const structureTrend = classifyTrend(swings);
  reasons.push(
    `${timeframeUsed} swing sequence → ${structureTrend} ` +
    `(${swings.slice(-4).map((s) => s.label).filter(Boolean).join(' ') || 'n/a'}).`,
  );

  const dirForBos = structureTrend === 'bullish' ? 'long' : structureTrend === 'bearish' ? 'short' : 'long';
  let bos = detectBreakOfStructure({ candles: base, direction: dirForBos, pair });
  if (!bos && structureTrend === 'ranging') {
    bos = detectBreakOfStructure({ candles: base, direction: 'short', pair });
  }
  const bosDetected = Boolean(bos);
  if (bosDetected) reasons.push(bos.reason);

  const priorTrend = structureTrend === 'ranging' ? null : structureTrend;
  const choch = priorTrend ? detectChangeOfCharacter({ candles: base, priorTrend, pair }) : null;
  const chochDetected = Boolean(choch);
  if (chochDetected) reasons.push(choch.reason);

  let lastStructureBreak = null;
  if (chochDetected) {
    lastStructureBreak = { kind: 'CHoCH', direction: choch.direction, level: choch.brokenLevel, reason: choch.reason };
  } else if (bosDetected) {
    lastStructureBreak = { kind: 'BOS', direction: bos.direction, level: bos.brokenLevel, reason: bos.reason };
  }

  let structureStrength = 40;
  const recentLabels = swings.map((s) => s.label).filter(Boolean).slice(-4);
  const aligned =
    (structureTrend === 'bullish' && recentLabels.includes('HH') && recentLabels.includes('HL') && !recentLabels.includes('LL')) ||
    (structureTrend === 'bearish' && recentLabels.includes('LL') && recentLabels.includes('LH') && !recentLabels.includes('HH'));
  if (aligned) structureStrength += 25;
  if (structureTrend !== 'ranging') structureStrength += 10;
  if (bosDetected && ((bos.direction === 'bullish' && structureTrend === 'bullish') ||
                      (bos.direction === 'bearish' && structureTrend === 'bearish'))) {
    structureStrength += 20;
    reasons.push('BOS confirms prevailing structure direction.');
  }
  if (chochDetected) structureStrength = Math.min(structureStrength + 10, 95);
  if (structureTrend === 'ranging') structureStrength = Math.min(structureStrength, 45);
  structureStrength = Math.max(0, Math.min(100, structureStrength));

  return {
    structureTrend,
    bosDetected, bos: bos || null,
    chochDetected, choch: choch || null,
    lastStructureBreak,
    structureStrength,
    swings: swings.slice(-8),
    timeframeUsed,
    h1Used: false,
    reasons,
  };
}
