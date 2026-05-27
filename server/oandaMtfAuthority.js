/**
 * server/oandaMtfAuthority.js
 *
 * Higher-timeframe DIRECTIONAL AUTHORITY check — uses structure (HHHL / LHLL),
 * not just EMA alignment.
 *
 *   4H  = primary directional bias       (loudest vote)
 *   1H  = confirmation bias
 *   15m = entry-timing bias
 *
 * Why this exists alongside the existing alignment engine: `computeAlignment`
 * folds EMA trend across all timeframes into a single score. That's good for
 * an aggregate "are we aligned?" answer, but it doesn't distinguish a
 * counter-trend M15 setup from one that genuinely respects the H4 structure
 * grade. This module is stricter — a clean H4 bearish structure cannot be
 * overridden by an M15 EMA cross unless explicitly flagged as a reversal.
 *
 *   assessMtfAuthority({ direction, h4Candles, h1Candles, m15Candles, macro, structure })
 *     → {
 *         higherTimeframeBias:    'bullish' | 'bearish' | 'mixed',
 *         confirmationTimeframeBias: 'bullish' | 'bearish' | 'mixed',
 *         entryTimeframeBias:     'bullish' | 'bearish' | 'mixed',
 *         multiTimeframeAlignmentScore: 0–100,
 *         multiTimeframeReason: string,
 *         conflict: boolean,           // direction explicitly opposes HTF authority
 *         isReversalSetup: boolean,    // entry TF + H1 oppose H4 — counts as reversal
 *         requiresReversalEvidence: boolean,
 *       }
 */

import { atr } from './oandaIndicators.js';

const SWING_LOOKBACK = 3;

function findPivots(candles, lookback = SWING_LOOKBACK) {
  const highs = [];
  const lows  = [];
  if (!Array.isArray(candles) || candles.length < lookback * 2 + 1) return { highs, lows };
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true, isLow = true;
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

/**
 * Classify a timeframe's structure bias from its last 4 pivots.
 *  HHHL → bullish    LHLL → bearish    mixed → mixed
 */
function biasFromStructure(candles) {
  if (!Array.isArray(candles) || candles.length < 30) return 'mixed';
  const { highs, lows } = findPivots(candles.slice(-50));
  if (highs.length < 2 || lows.length < 2) return 'mixed';
  const lastHi  = highs[highs.length - 1].price;
  const prevHi  = highs[highs.length - 2].price;
  const lastLo  = lows [lows.length  - 1].price;
  const prevLo  = lows [lows.length  - 2].price;

  const higherHighs = lastHi > prevHi;
  const higherLows  = lastLo > prevLo;
  const lowerHighs  = lastHi < prevHi;
  const lowerLows   = lastLo < prevLo;

  if (higherHighs && higherLows) return 'bullish';
  if (lowerHighs  && lowerLows)  return 'bearish';
  return 'mixed';
}

function biasMatchesDirection(bias, direction) {
  if (direction === 'long')  return bias === 'bullish';
  if (direction === 'short') return bias === 'bearish';
  return false;
}

function biasOpposesDirection(bias, direction) {
  if (direction === 'long')  return bias === 'bearish';
  if (direction === 'short') return bias === 'bullish';
  return false;
}

export function assessMtfAuthority({
  direction, h4Candles, h1Candles, m15Candles, macro, structure,
}) {
  // Structure-based bias for each TF
  const h4Bias  = biasFromStructure(h4Candles);
  const h1Bias  = biasFromStructure(h1Candles);
  const m15Bias = biasFromStructure(m15Candles);

  // EMA-based bias as a secondary signal (from existing waterfall layers)
  const h4EmaBias  = macro?.h4Trend       === 'bullish' ? 'bullish' : macro?.h4Trend       === 'bearish' ? 'bearish' : 'mixed';
  const h1EmaBias  = structure?.h1Trend   === 'bullish' ? 'bullish' : structure?.h1Trend   === 'bearish' ? 'bearish' : 'mixed';

  // Authoritative bias = structure if it's directional, else EMA fallback
  const higherTimeframeBias       = h4Bias  !== 'mixed' ? h4Bias  : h4EmaBias;
  const confirmationTimeframeBias = h1Bias  !== 'mixed' ? h1Bias  : h1EmaBias;
  const entryTimeframeBias        = m15Bias;

  // ── Conflict check ────────────────────────────────────────────────────────
  // Hard conflict: direction opposes 4H bias AND 1H bias.
  const h4Opposes = biasOpposesDirection(higherTimeframeBias, direction);
  const h1Opposes = biasOpposesDirection(confirmationTimeframeBias, direction);
  const h4Matches = biasMatchesDirection(higherTimeframeBias, direction);
  const h1Matches = biasMatchesDirection(confirmationTimeframeBias, direction);

  const hardConflict = h4Opposes && h1Opposes;
  // Reversal setup: entry TF + H1 oppose H4 — could be valid IF flow/sweep evidence confirms it.
  const isReversalSetup = h4Opposes && !h1Opposes && biasOpposesDirection(entryTimeframeBias, h4Bias);

  // ── Score ─────────────────────────────────────────────────────────────────
  let score = 50;
  if (h4Matches) score += 25;
  else if (h4Opposes) score -= 30;
  if (h1Matches) score += 15;
  else if (h1Opposes) score -= 15;
  if (biasMatchesDirection(entryTimeframeBias, direction)) score += 10;
  else if (biasOpposesDirection(entryTimeframeBias, direction)) score -= 5;
  if (higherTimeframeBias === 'mixed' || confirmationTimeframeBias === 'mixed') score -= 8;
  if (hardConflict) score = Math.min(score, 15);
  score = Math.max(0, Math.min(100, Math.round(score)));

  // ── Reason ────────────────────────────────────────────────────────────────
  const parts = [];
  parts.push(`H4 ${higherTimeframeBias}`);
  parts.push(`H1 ${confirmationTimeframeBias}`);
  parts.push(`M15 ${entryTimeframeBias}`);
  parts.push(`(structure: H4=${h4Bias}, H1=${h1Bias}, M15=${m15Bias})`);
  if (hardConflict)   parts.push(`HARD CONFLICT: ${direction} opposes both H4 and H1`);
  if (isReversalSetup) parts.push('possible reversal setup (entry TF + H1 oppose H4)');
  const multiTimeframeReason = parts.join(' · ');

  return {
    higherTimeframeBias,
    confirmationTimeframeBias,
    entryTimeframeBias,
    multiTimeframeAlignmentScore: score,
    multiTimeframeReason,
    conflict: hardConflict,
    isReversalSetup,
    requiresReversalEvidence: isReversalSetup,
    detail: {
      h4Bias, h1Bias, m15Bias,
      h4EmaBias, h1EmaBias,
      h4Matches, h1Matches, h4Opposes, h1Opposes,
    },
  };
}

// Silence the unused-import lint for `atr` — keeping the import so a future
// expansion (e.g. weighting by ATR-of-each-TF) doesn't have to re-add it.
void atr;
