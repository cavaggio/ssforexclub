import { evaluatePrimaryTimeframeAlignment } from './primaryTimeframeAlignment.js';
/**
 * server/oandaMtfAnalysis.js
 *
 * Institutional multi-timeframe market analysis engine.
 *
 * Replaces the old single-pass indicator scoring with a 3-layer waterfall:
 *
 *   Layer 1 — Macro       (Daily + H4)  : direction & regime
 *   Layer 2 — Structure   (H1 + M30)    : pullback / continuation / reversal-risk
 *   Layer 3 — Momentum    (M15 + M5)    : execution trigger
 *
 *   computeAlignment(macro, structure, momentum) folds the three layers into:
 *     - timeframeAlignmentScore (0–100)
 *     - alignmentStatus         ('strong' | 'mixed' | 'conflicting')
 *     - dominantBias            ('bullish' | 'bearish' | 'ranging')
 *     - conflictingTimeframes[]
 *     - tradeQualified          (boolean)
 *     - rejectionReasons[]
 *
 * Indicators (RSI, MACD, EMA, ATR) appear ONLY inside the momentum layer as
 * supporting confirmation. No indicator alone can qualify a trade.
 */

import {
  ema,
  rsi,
  macd,
  atr,
  detectTrend,
  emaAlignment,
  candleConfirmation,
  srProximity,
} from './oandaIndicators.js';

// ─── Helpers shared across layers ─────────────────────────────────────────────

function getPipSize(pair) {
  if (pair.includes('JPY'))                      return 0.01;
  if (pair === 'XAU_USD' || pair === 'XAG_USD')  return 0.01;
  return 0.0001;
}

function pctChange(a, b) {
  if (!b) return 0;
  return ((a - b) / b) * 100;
}

function findSwings(candles, lookback = 3) {
  const highs = [];
  const lows  = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const slice = candles.slice(i - lookback, i + lookback + 1);
    const h = candles[i].high;
    const l = candles[i].low;
    if (h === Math.max(...slice.map(c => c.high))) highs.push({ i, price: h });
    if (l === Math.min(...slice.map(c => c.low)))  lows.push({ i, price: l });
  }
  return { highs, lows };
}

function findKeyLevels(candles, pipSize) {
  if (!candles || candles.length < 30) return [];
  const recent = candles.slice(-60);
  const { highs, lows } = findSwings(recent, 3);

  // De-duplicate within ~30 pips
  const merged = [];
  const tolerance = 30 * pipSize;
  for (const lvl of [
    ...highs.map(h => ({ price: h.price, kind: 'resistance' })),
    ...lows.map (l => ({ price: l.price, kind: 'support'    })),
  ]) {
    const dup = merged.find(m => Math.abs(m.price - lvl.price) < tolerance && m.kind === lvl.kind);
    if (!dup) merged.push(lvl);
  }
  return merged.slice(-6); // most recent 6 key levels
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 1 — MACRO MARKET REGIME
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Inputs:
 *   - dailyCandles  : ≥30 daily candles (60 preferred)
 *   - h4Candles     : ≥50 H4 candles
 *   - pair          : 'EUR_USD', 'USD_JPY', …
 *
 * Returns:
 *   {
 *     macroBias:        'bullish' | 'bearish' | 'ranging',
 *     trendStrength:    0–100,
 *     volatilityRegime: 'compressed' | 'normal' | 'expanded',
 *     keyLevels:        [{ price, kind }],
 *     marketStructure:  { type, hasBOS, hasHigherHighs, hasHigherLows, hasLowerHighs, hasLowerLows },
 *     atrPips:          number,
 *     atrPipsHistorical: number,
 *     macroConfidence:  0–100,
 *     dailyTrend, h4Trend, dailyAlignment, h4Alignment,
 *     notes:            string[]
 *   }
 */

function applyPrimaryTimeframeGate(signalLike, direction) {
  const primary = evaluatePrimaryTimeframeAlignment(signalLike, direction);

  if (!signalLike || typeof signalLike !== 'object') return primary;

  signalLike.primaryTimeframeAlignment = primary;

  if (!Array.isArray(signalLike.warnings)) signalLike.warnings = [];
  if (!Array.isArray(signalLike.rejectionReasons)) signalLike.rejectionReasons = [];

  if (!primary.passed) {
    signalLike.rejectionReasons.push(primary.reason);
  } else if (primary.contextConflicts?.length) {
    signalLike.warnings.push(primary.reason);
    signalLike.rejectionReasons = signalLike.rejectionReasons.filter((r) => {
      const s = String(r || '').toLowerCase();
      return !(
        s.includes('alignment score') ||
        s.includes('timeframe score') ||
        s.includes('h1') ||
        s.includes('m30') ||
        s.includes('m5')
      );
    });
  }

  return primary;
}

export function analyzeMacro({ dailyCandles, h4Candles, pair }) {
  const notes = [];
  const pipSize = getPipSize(pair);

  // Minimum data check — degrade gracefully if Daily is missing
  const dailyOk = Array.isArray(dailyCandles) && dailyCandles.length >= 30;
  const h4Ok    = Array.isArray(h4Candles)    && h4Candles.length    >= 50;

  if (!h4Ok) {
    return {
      macroBias: 'ranging',
      trendStrength: 0,
      volatilityRegime: 'compressed',
      keyLevels: [],
      marketStructure: { type: 'unknown' },
      atrPips: 0,
      atrPipsHistorical: 0,
      macroConfidence: 0,
      dailyTrend: 'neutral', h4Trend: 'neutral',
      dailyAlignment: 'mixed', h4Alignment: 'mixed',
      notes: ['Insufficient H4 history for macro analysis'],
    };
  }

  const dailyCloses = dailyOk ? dailyCandles.map(c => c.close) : [];
  const h4Closes    = h4Candles.map(c => c.close);

  const dailyTrend     = dailyOk ? detectTrend(dailyCloses)   : 'neutral';
  const dailyAlignment = dailyOk ? emaAlignment(dailyCloses)  : 'mixed';
  const h4Trend        = detectTrend(h4Closes);
  const h4Alignment    = emaAlignment(h4Closes);

  // Macro bias — vote-based combination of Daily + H4 trend.
  //   Daily and H4 each contribute ±1 / 0 to a combined vote.
  //   |vote| ≥ 1 → that direction. 0 → ranging.
  //   This requires either both TFs to agree, OR one to be directional while
  //   the other is neutral.
  let macroBias = 'ranging';
  const dailyVote = dailyOk
    ? (dailyTrend === 'bullish' ? 1 : dailyTrend === 'bearish' ? -1 : 0)
    : 0;
  const h4Vote = h4Trend === 'bullish' ? 1 : h4Trend === 'bearish' ? -1 : 0;
  const combined = dailyVote + h4Vote;

  if      (combined >=  1) macroBias = 'bullish';
  else if (combined <= -1) macroBias = 'bearish';

  if (dailyOk && dailyTrend !== 'neutral' && h4Trend !== 'neutral' && dailyTrend !== h4Trend) {
    notes.push(`Daily ${dailyTrend} / H4 ${h4Trend} — directionally split, macro forced to ranging`);
    macroBias = 'ranging';
  }
  if (!dailyOk) {
    notes.push('Daily candles unavailable — macro derived from H4 only');
  }

  // ── Trend strength on a 0–100 scale ────────────────────────────────────────
  // Combine: EMA alignment quality + EMA slope + H4 momentum
  let trendStrength = 0;
  if (dailyOk && dailyTrend !== 'neutral')   trendStrength += 25;
  if (dailyAlignment !== 'mixed')            trendStrength += 25;
  if (h4Trend !== 'neutral')                 trendStrength += 25;
  if (h4Alignment !== 'mixed')               trendStrength += 25;
  trendStrength = Math.min(100, trendStrength);

  // ── Volatility regime — compare current H4 ATR to its own historical mean ──
  const atrCurrentRaw     = atr(h4Candles.slice(-30), 14);
  const atrHistoricalRaw  = atr(h4Candles, 14);
  const atrPips           = atrCurrentRaw    ? +(atrCurrentRaw    / pipSize).toFixed(1) : 0;
  const atrPipsHistorical = atrHistoricalRaw ? +(atrHistoricalRaw / pipSize).toFixed(1) : 0;

  let volatilityRegime = 'normal';
  if (atrPipsHistorical > 0) {
    const ratio = atrPips / atrPipsHistorical;
    if      (ratio < 0.7)  volatilityRegime = 'compressed';
    else if (ratio > 1.3)  volatilityRegime = 'expanded';
  }

  // ── Market structure on H4 ─────────────────────────────────────────────────
  const recent = h4Candles.slice(-40);
  const { highs, lows } = findSwings(recent, 2);
  const hasHigherHighs = highs.length >= 2 && highs[highs.length - 1].price > highs[highs.length - 2].price;
  const hasHigherLows  = lows.length  >= 2 && lows [lows.length  - 1].price > lows [lows.length  - 2].price;
  const hasLowerHighs  = highs.length >= 2 && highs[highs.length - 1].price < highs[highs.length - 2].price;
  const hasLowerLows   = lows.length  >= 2 && lows [lows.length  - 1].price < lows [lows.length  - 2].price;

  const lastClose = recent[recent.length - 1].close;
  const prevHigh  = highs.length ? highs[highs.length - 1].price : null;
  const prevLow   = lows.length  ? lows [lows.length  - 1].price : null;
  const hasBOS    = (prevHigh !== null && lastClose > prevHigh) ||
                    (prevLow  !== null && lastClose < prevLow);

  let structureType = 'unknown';
  if      (hasHigherHighs && hasHigherLows) structureType = 'trending_bullish';
  else if (hasLowerHighs  && hasLowerLows)  structureType = 'trending_bearish';
  else if (hasLowerHighs  && hasHigherLows) structureType = 'consolidation';
  else if (hasHigherHighs && hasLowerLows)  structureType = 'expansion';

  // Key levels from H4 swings
  const keyLevels = findKeyLevels(h4Candles, pipSize);

  // Sanity: if macroBias says bullish but structure is bearish, demote to ranging
  if (macroBias === 'bullish' && structureType === 'trending_bearish') {
    macroBias = 'ranging';
    notes.push('H4 structure contradicts trend — bias downgraded to ranging');
  }
  if (macroBias === 'bearish' && structureType === 'trending_bullish') {
    macroBias = 'ranging';
    notes.push('H4 structure contradicts trend — bias downgraded to ranging');
  }

  // ── Macro confidence — how confident are we in the macro direction? ────────
  let macroConfidence = 0;
  if (macroBias !== 'ranging') {
    macroConfidence += 30; // base for a directional bias
    if (dailyOk && dailyTrend === (macroBias === 'bullish' ? 'bullish' : 'bearish')) macroConfidence += 15;
    if (h4Trend === (macroBias === 'bullish' ? 'bullish' : 'bearish'))               macroConfidence += 15;
    if (dailyAlignment === `aligned_${macroBias}`)                                    macroConfidence += 10;
    if (h4Alignment    === `aligned_${macroBias}`)                                    macroConfidence += 10;
    if (structureType  === `trending_${macroBias}`)                                   macroConfidence += 15;
    if (hasBOS)                                                                       macroConfidence += 5;
    if (volatilityRegime === 'expanded')                                              macroConfidence += 5;
    if (volatilityRegime === 'compressed')                                            macroConfidence -= 5;
  }
  macroConfidence = Math.max(0, Math.min(100, macroConfidence));

  return {
    macroBias,
    trendStrength,
    volatilityRegime,
    keyLevels,
    marketStructure: {
      type: structureType,
      hasBOS,
      hasHigherHighs, hasHigherLows, hasLowerHighs, hasLowerLows,
    },
    atrPips,
    atrPipsHistorical,
    macroConfidence,
    dailyTrend, h4Trend,
    dailyAlignment, h4Alignment,
    notes,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 2 — STRUCTURE CONFIRMATION
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Validates whether 1H / 30M structure agrees with macro bias.
 *
 * Inputs:
 *   - h1Candles : ≥50 H1 candles
 *   - m30Candles: ≥60 M30 candles
 *   - macro     : macro analysis output
 *   - pair      : string
 *
 * Returns:
 *   {
 *     structureAligned:        boolean,        — direction agrees with macro
 *     pullbackDetected:        boolean,        — counter-trend pullback inside macro
 *     reversalRisk:            'low'|'medium'|'high',
 *     continuationProbability: 0–100,
 *     structuralConfidence:    0–100,
 *     h1Trend, m30Trend, h1Alignment, m30Alignment,
 *     nearKeyLevel:            null | { kind, distancePips },
 *     notes:                   string[]
 *   }
 */
export function analyzeStructure({ h1Candles, m30Candles, macro, pair }) {
  const notes = [];
  const pipSize = getPipSize(pair);

  const h1Ok  = Array.isArray(h1Candles)  && h1Candles.length  >= 50;
  const m30Ok = Array.isArray(m30Candles) && m30Candles.length >= 60;

  if (!h1Ok && !m30Ok) {
    return {
      structureAligned: false,
      pullbackDetected: false,
      reversalRisk: 'high',
      continuationProbability: 0,
      structuralConfidence: 0,
      h1Trend: 'neutral', m30Trend: 'neutral',
      h1Alignment: 'mixed', m30Alignment: 'mixed',
      nearKeyLevel: null,
      notes: ['Insufficient H1 / M30 candles for structure analysis'],
    };
  }

  const h1Closes  = h1Ok  ? h1Candles .map(c => c.close) : [];
  const m30Closes = m30Ok ? m30Candles.map(c => c.close) : [];

  const h1Trend      = h1Ok  ? detectTrend(h1Closes)  : 'neutral';
  const m30Trend     = m30Ok ? detectTrend(m30Closes) : 'neutral';
  const h1Alignment  = h1Ok  ? emaAlignment(h1Closes)  : 'mixed';
  const m30Alignment = m30Ok ? emaAlignment(m30Closes) : 'mixed';

  // ── Alignment to macro ────────────────────────────────────────────────────
  const macroDir = macro.macroBias;             // 'bullish' | 'bearish' | 'ranging'
  let structureAligned = false;
  if (macroDir === 'bullish') {
    structureAligned = (h1Trend === 'bullish' || m30Trend === 'bullish');
  } else if (macroDir === 'bearish') {
    structureAligned = (h1Trend === 'bearish' || m30Trend === 'bearish');
  }

  // ── Pullback detection ────────────────────────────────────────────────────
  // Definition: macro is directional, but H1 closes are pulling back against
  // the macro direction over the last ~8 bars while remaining above/below the
  // 50-EMA on M30 (i.e. healthy pullback, not breakdown).
  let pullbackDetected = false;
  if (macroDir !== 'ranging' && h1Ok && h1Closes.length >= 12) {
    const last8 = h1Closes.slice(-8);
    const oldest = last8[0];
    const newest = last8[last8.length - 1];
    const movePct = pctChange(newest, oldest);
    const m30Ema50 = m30Ok ? ema(m30Closes, 50) : null;
    const currentClose = h1Closes[h1Closes.length - 1];

    if (macroDir === 'bullish' && movePct < -0.1 && (m30Ema50 === null || currentClose > m30Ema50)) {
      pullbackDetected = true;
      notes.push('Bullish-macro pullback: H1 retracing while M30 still above 50-EMA');
    }
    if (macroDir === 'bearish' && movePct > 0.1 && (m30Ema50 === null || currentClose < m30Ema50)) {
      pullbackDetected = true;
      notes.push('Bearish-macro pullback: H1 retracing while M30 still below 50-EMA');
    }
  }

  // ── Reversal risk ─────────────────────────────────────────────────────────
  // Higher when:
  //  - H1 and M30 disagree with the macro direction simultaneously
  //  - Price prints a rejection wick into a macro key level
  //  - M30 EMA alignment flips against the macro direction
  let reversalRisk = 'low';
  const oppositeOf = macroDir === 'bullish' ? 'bearish' : macroDir === 'bearish' ? 'bullish' : null;

  if (oppositeOf) {
    const h1Against  = h1Trend  === oppositeOf;
    const m30Against = m30Trend === oppositeOf;
    if (h1Against && m30Against)                                              reversalRisk = 'high';
    else if (h1Against || m30Against)                                         reversalRisk = 'medium';
    if (m30Alignment === `aligned_${oppositeOf}`)                             reversalRisk = 'high';
  }

  // ── Continuation probability ───────────────────────────────────────────────
  let continuationProbability = 0;
  if (macroDir !== 'ranging') {
    if (structureAligned)                       continuationProbability += 35;
    if (h1Trend  === macroDir)                  continuationProbability += 15;
    if (m30Trend === macroDir)                  continuationProbability += 15;
    if (h1Alignment  === `aligned_${macroDir}`) continuationProbability += 10;
    if (m30Alignment === `aligned_${macroDir}`) continuationProbability += 10;
    if (pullbackDetected)                       continuationProbability += 10;   // pullbacks are entries
    if (reversalRisk === 'medium')              continuationProbability -= 15;
    if (reversalRisk === 'high')                continuationProbability -= 35;
  }
  continuationProbability = Math.max(0, Math.min(100, continuationProbability));

  // ── Proximity to macro key levels ─────────────────────────────────────────
  // Only "unbroken" levels are real barriers:
  //   - For bullish bias: resistance levels ABOVE current price (haven't been
  //     broken yet). A swing high formed an hour ago that price has since
  //     pushed through is NOT resistance any more.
  //   - For bearish bias: support levels BELOW current price.
  // This stops the filter from rejecting every clean trend trade for being
  // "near resistance" when in fact the nearest swing is just the most recent
  // micro-high that price already cleared.
  let nearKeyLevel = null;
  if (h1Ok && macro.keyLevels && macro.keyLevels.length) {
    const px = h1Closes[h1Closes.length - 1];
    const relevantLevels = macro.keyLevels.filter(lvl => {
      if (macroDir === 'bullish' && lvl.kind === 'resistance') return lvl.price > px;
      if (macroDir === 'bearish' && lvl.kind === 'support')    return lvl.price < px;
      return false;
    });
    let closest = null;
    let closestDist = Infinity;
    for (const lvl of relevantLevels) {
      const dist = Math.abs(px - lvl.price);
      if (dist < closestDist) { closest = lvl; closestDist = dist; }
    }
    if (closest) {
      const distPips = closestDist / pipSize;
      if (distPips < 30) {
        nearKeyLevel = { kind: closest.kind, distancePips: +distPips.toFixed(1), price: closest.price };
        // Real reversal-risk band: < 8p = high (entry sits at the wall),
        // 8–20p = medium (TP at 60p almost certainly slips through it).
        if (distPips < 8) {
          reversalRisk = 'high';
          notes.push(`Price ${distPips.toFixed(1)}p from unbroken H4 ${closest.kind} — entry is high-risk`);
        } else if (distPips < 20 && reversalRisk !== 'high') {
          reversalRisk = 'medium';
          notes.push(`Price ${distPips.toFixed(1)}p from H4 ${closest.kind} — limited room to TP`);
        }
      }
    }
  }

  // ── Structural confidence ─────────────────────────────────────────────────
  let structuralConfidence = 0;
  if (structureAligned)              structuralConfidence += 40;
  if (h1Trend  === macroDir)         structuralConfidence += 15;
  if (m30Trend === macroDir)         structuralConfidence += 10;
  if (h1Alignment  === `aligned_${macroDir}`) structuralConfidence += 10;
  if (m30Alignment === `aligned_${macroDir}`) structuralConfidence += 10;
  if (pullbackDetected)              structuralConfidence += 5;
  if (reversalRisk === 'medium')     structuralConfidence -= 20;
  if (reversalRisk === 'high')       structuralConfidence -= 40;
  structuralConfidence = Math.max(0, Math.min(100, structuralConfidence));

  return {
    structureAligned,
    pullbackDetected,
    reversalRisk,
    continuationProbability,
    structuralConfidence,
    h1Trend, m30Trend, h1Alignment, m30Alignment,
    nearKeyLevel,
    notes,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 3 — MOMENTUM & EXECUTION
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Determines whether right now is a precise execution moment. Indicators (RSI,
 * MACD, EMA) are used HERE as supporting confirmation — they cannot
 * single-handedly qualify a trade.
 *
 * Inputs:
 *   - m15Candles : ≥60 M15 candles
 *   - m5Candles  : ≥30 M5 candles
 *   - structure  : structure analysis output (carries macroBias via the caller)
 *   - macroBias  : 'bullish' | 'bearish' | 'ranging'
 *   - pair       : string
 *   - spreadPips : current pair spread (acts as an execution-quality cap)
 *   - maxSpreadPips
 *
 * Returns:
 *   {
 *     executionSignal:     'long' | 'short' | null,
 *     entryQuality:        0–100,
 *     momentumStrength:    0–100,
 *     executionConfidence: 0–100,
 *     timingScore:         0–100,
 *     candleConfirmation:  'bullish'|'bearish'|'doji'|'unknown',
 *     m15Trend, m5Trend, m15Alignment, m5Alignment,
 *     rsi:   number | null,
 *     macd:  { macd, signal, histogram } | null,
 *     atrPips: number,
 *     notes: string[]
 *   }
 */
export function analyzeMomentum({
  m15Candles, m5Candles,
  macroBias, structure,
  pair, spreadPips, maxSpreadPips,
}) {
  const notes = [];
  const pipSize = getPipSize(pair);

  const m15Ok = Array.isArray(m15Candles) && m15Candles.length >= 60;
  const m5Ok  = Array.isArray(m5Candles)  && m5Candles.length  >= 30;

  if (!m15Ok) {
    return {
      executionSignal: null,
      entryQuality: 0, momentumStrength: 0, executionConfidence: 0, timingScore: 0,
      candleConfirmation: 'unknown',
      m15Trend: 'neutral', m5Trend: 'neutral',
      m15Alignment: 'mixed', m5Alignment: 'mixed',
      rsi: null, macd: null, atrPips: 0,
      notes: ['Insufficient M15 candles for momentum analysis'],
    };
  }

  const m15Closes = m15Candles.map(c => c.close);
  const m5Closes  = m5Ok ? m5Candles.map(c => c.close) : [];

  const m15Trend     = detectTrend(m15Closes);
  const m15Alignment = emaAlignment(m15Closes);
  const m5Trend      = m5Ok ? detectTrend(m5Closes)  : 'neutral';
  const m5Alignment  = m5Ok ? emaAlignment(m5Closes) : 'mixed';

  const rsiVal = rsi(m15Closes, 14);
  const macdVal = macd(m15Closes);
  const atrVal  = atr(m15Candles, 14);
  const atrPips = atrVal ? +(atrVal / pipSize).toFixed(2) : 0;
  const candleConf = candleConfirmation(m15Candles);

  // ── Determine execution direction ─────────────────────────────────────────
  // Must agree with macro bias unless macro is ranging.
  //
  // Confirmation strength scoring (the M15 vote is no longer all-or-nothing):
  //   full    — both M15 trend AND M15 EMA-alignment match macro direction
  //   partial — exactly one of (trend, alignment) matches AND the other is not
  //             opposing (either matches the macro side or is neutral/mixed)
  //   none    — neither matches, OR one matches but the other is opposite
  //
  // A "partial" M15 still issues an execution signal but pays a confidence
  // penalty downstream. A "none" still blocks — that case usually means the
  // M15 is actively opposing the macro (real conflict, not just a flat bar).
  let executionSignal = null;
  let executionConfirmation = 'none';   // 'full' | 'partial' | 'none'
  const matchesBullish = (t, a) => (t === 'bullish' || a === 'aligned_bullish');
  const matchesBearish = (t, a) => (t === 'bearish' || a === 'aligned_bearish');
  const opposesBullish = (t, a) => (t === 'bearish' || a === 'aligned_bearish');
  const opposesBearish = (t, a) => (t === 'bullish' || a === 'aligned_bullish');

  if (macroBias === 'bullish') {
    const trendMatch  = m15Trend === 'bullish';
    const alignMatch  = m15Alignment === 'aligned_bullish';
    const trendOpp    = m15Trend === 'bearish';
    const alignOpp    = m15Alignment === 'aligned_bearish';
    if (trendMatch && alignMatch)                                executionConfirmation = 'full';
    else if ((trendMatch && !alignOpp) || (alignMatch && !trendOpp)) executionConfirmation = 'partial';
    if (executionConfirmation !== 'none') {
      executionSignal = 'long';
      if (executionConfirmation === 'partial') {
        notes.push(`M15 partial confirmation (trend=${m15Trend}, align=${m15Alignment}) — long signal with reduced confidence`);
      }
    } else {
      notes.push(`M15 opposes bullish macro (trend=${m15Trend}, align=${m15Alignment}) — no long trigger`);
    }
  } else if (macroBias === 'bearish') {
    const trendMatch  = m15Trend === 'bearish';
    const alignMatch  = m15Alignment === 'aligned_bearish';
    const trendOpp    = m15Trend === 'bullish';
    const alignOpp    = m15Alignment === 'aligned_bullish';
    if (trendMatch && alignMatch)                                executionConfirmation = 'full';
    else if ((trendMatch && !alignOpp) || (alignMatch && !trendOpp)) executionConfirmation = 'partial';
    if (executionConfirmation !== 'none') {
      executionSignal = 'short';
      if (executionConfirmation === 'partial') {
        notes.push(`M15 partial confirmation (trend=${m15Trend}, align=${m15Alignment}) — short signal with reduced confidence`);
      }
    } else {
      notes.push(`M15 opposes bearish macro (trend=${m15Trend}, align=${m15Alignment}) — no short trigger`);
    }
  } else {
    notes.push('Macro is ranging — no execution direction issued');
  }
  // Silence the unused-helper lint that some bundlers emit.
  void matchesBullish; void matchesBearish; void opposesBullish; void opposesBearish;

  // ── Momentum strength ────────────────────────────────────────────────────
  // Combination of RSI direction quality, MACD histogram direction & magnitude,
  // M5 alignment with the execution direction. Each indicator is just a partial
  // contributor — no single one decides the trade.
  let momentumStrength = 0;
  if (executionSignal && rsiVal !== null) {
    if (executionSignal === 'long' && rsiVal > 50 && rsiVal < 75) momentumStrength += 25;
    else if (executionSignal === 'short' && rsiVal < 50 && rsiVal > 25) momentumStrength += 25;
    else if (executionSignal === 'long' && rsiVal >= 45)                momentumStrength += 10;
    else if (executionSignal === 'short' && rsiVal <= 55)               momentumStrength += 10;
  }
  if (executionSignal && macdVal !== null) {
    if (executionSignal === 'long'  && macdVal.histogram > 0 && macdVal.macd > macdVal.signal) momentumStrength += 25;
    else if (executionSignal === 'short' && macdVal.histogram < 0 && macdVal.macd < macdVal.signal) momentumStrength += 25;
    else if (executionSignal === 'long'  && macdVal.macd > 0) momentumStrength += 10;
    else if (executionSignal === 'short' && macdVal.macd < 0) momentumStrength += 10;
  }
  if (executionSignal && m5Ok) {
    // M5 confirmation tiers — full alignment, trend-only, or neutral. Only an
    // outright opposite M5 hurts; a neutral/mixed M5 just doesn't add the bonus.
    const m5FullAlign  =
      (executionSignal === 'long'  && m5Alignment === 'aligned_bullish') ||
      (executionSignal === 'short' && m5Alignment === 'aligned_bearish');
    const m5TrendOnly  =
      (executionSignal === 'long'  && m5Trend === 'bullish' && m5Alignment !== 'aligned_bearish') ||
      (executionSignal === 'short' && m5Trend === 'bearish' && m5Alignment !== 'aligned_bullish');
    const m5Opposing   =
      (executionSignal === 'long'  && (m5Trend === 'bearish' || m5Alignment === 'aligned_bearish')) ||
      (executionSignal === 'short' && (m5Trend === 'bullish' || m5Alignment === 'aligned_bullish'));
    if      (m5FullAlign) momentumStrength += 25;
    else if (m5TrendOnly) momentumStrength += 12;
    else if (m5Opposing)  momentumStrength -= 8;       // active opposition is a penalty
    // else (M5 neutral) → no contribution, no penalty — point #3 from the spec
  }
  if (executionSignal) {
    const candleConfirms =
      (executionSignal === 'long'  && candleConf === 'bullish') ||
      (executionSignal === 'short' && candleConf === 'bearish');
    if (candleConfirms) momentumStrength += 25;
  }
  momentumStrength = Math.max(0, Math.min(100, momentumStrength));

  // ── Entry quality — spread, ATR health, S/R clearance ────────────────────
  let entryQuality = 0;
  const sr = srProximity(m15Candles, pipSize);
  if (executionSignal) {
    // ATR healthy band
    if (atrPips >= 6 && atrPips <= 50) entryQuality += 30;
    else if (atrPips >= 4)             entryQuality += 15;

    // Spread quality
    if (maxSpreadPips && spreadPips !== undefined && spreadPips !== null) {
      const ratio = spreadPips / maxSpreadPips;
      if      (ratio <= 0.3) entryQuality += 30;
      else if (ratio <= 0.6) entryQuality += 18;
      else if (ratio <= 0.9) entryQuality += 8;
    }

    // S/R clearance — punish entries that have very little room to TP
    if (sr) {
      const clearForLong  = executionSignal === 'long'  && sr.distToResistancePips > 30;
      const clearForShort = executionSignal === 'short' && sr.distToSupportPips    > 30;
      if (clearForLong || clearForShort) entryQuality += 20;
      else if (sr.distToResistancePips > 15 && sr.distToSupportPips > 15) entryQuality += 10;
      else notes.push('Tight S/R clearance — entry has limited room to target');
    }

    // M5 entry confirmation
    if (
      (executionSignal === 'long'  && m5Alignment === 'aligned_bullish') ||
      (executionSignal === 'short' && m5Alignment === 'aligned_bearish')
    ) entryQuality += 20;
  }
  entryQuality = Math.max(0, Math.min(100, entryQuality));

  // ── Timing score — how "fresh" is the move? ───────────────────────────────
  let timingScore = 0;
  if (executionSignal && m15Candles.length >= 5) {
    const last5 = m15Candles.slice(-5);
    const bullCount = last5.filter(c => c.close > c.open).length;
    const bearCount = 5 - bullCount;
    if (executionSignal === 'long'  && bullCount >= 3) timingScore += 50;
    if (executionSignal === 'short' && bearCount >= 3) timingScore += 50;
    if (atrPips > 0) {
      const last = m15Candles[m15Candles.length - 1];
      const bodyPips = Math.abs(last.close - last.open) / pipSize;
      // Trigger candle body > 50% of ATR — accelerating move
      if (bodyPips > atrPips * 0.5) timingScore += 50;
      else if (bodyPips > atrPips * 0.25) timingScore += 25;
    }
  }
  timingScore = Math.max(0, Math.min(100, timingScore));

  // ── Execution confidence — only > 0 when there's a valid signal ───────────
  let executionConfidence = 0;
  if (executionSignal) {
    executionConfidence =
      Math.round(0.35 * momentumStrength + 0.40 * entryQuality + 0.25 * timingScore);
    // Penalty if structure layer says reversal risk is high
    if (structure?.reversalRisk === 'high')   executionConfidence = Math.max(0, executionConfidence - 25);
    if (structure?.reversalRisk === 'medium') executionConfidence = Math.max(0, executionConfidence - 10);
    // Partial M15 confirmation pays a moderate confidence penalty — but it
    // doesn't block the trade. A real M15 conflict already blocks above.
    if (executionConfirmation === 'partial') {
      executionConfidence = Math.max(0, Math.round(executionConfidence * 0.75));
    }
  }

  return {
    executionSignal,
    executionConfirmation,           // 'full' | 'partial' | 'none'
    entryQuality,
    momentumStrength,
    executionConfidence,
    timingScore,
    candleConfirmation: candleConf,
    m15Trend, m5Trend, m15Alignment, m5Alignment,
    rsi:  rsiVal  !== null ? +rsiVal.toFixed(2) : null,
    macd: macdVal !== null ? {
      macd: +macdVal.macd.toFixed(6),
      signal: +macdVal.signal.toFixed(6),
      histogram: +macdVal.histogram.toFixed(6),
    } : null,
    atrPips,
    srProximity: sr,
    notes,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MULTI-TIMEFRAME ALIGNMENT ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Folds the three layers into a single alignment outcome.
 *
 * Returns:
 *   {
 *     timeframeAlignmentScore: 0–100,
 *     alignmentStatus:         'strong' | 'mixed' | 'conflicting',
 *     dominantBias:            'bullish' | 'bearish' | 'ranging',
 *     conflictingTimeframes:   string[],
 *     tradeQualified:          boolean,
 *     rejectionReasons:        string[],
 *     timeframes: { daily, h4, h1, m30, m15, m5 }
 *   }
 */
export function computeAlignment({
  macro, structure, momentum,
  minMacroConfidence    = 30,
  minStructuralConfidence = 30,
  minExecutionConfidence  = 35,
  minAlignmentScore       = 0,
  minRiskReward           = 3,
}) {
  const timeframes = {
    daily: macro.dailyTrend,
    h4:    macro.h4Trend,
    h1:    structure.h1Trend,
    m30:   structure.m30Trend,
    m15:   momentum.m15Trend,
    m5:    momentum.m5Trend,
  };

  // Convert per-TF trend to numeric (+1 bull / -1 bear / 0 neutral)
  const toNum = (t) => t === 'bullish' ? 1 : t === 'bearish' ? -1 : 0;
  const weights = { daily: 0.25, h4: 0.20, h1: 0.20, m30: 0.10, m15: 0.15, m5: 0.10 };

  const directional =
      weights.daily * toNum(timeframes.daily)
    + weights.h4    * toNum(timeframes.h4)
    + weights.h1    * toNum(timeframes.h1)
    + weights.m30   * toNum(timeframes.m30)
    + weights.m15   * toNum(timeframes.m15)
    + weights.m5    * toNum(timeframes.m5);

  let dominantBias = 'ranging';
  if      (directional >  0.35) dominantBias = 'bullish';
  else if (directional < -0.35) dominantBias = 'bearish';

  // Primary directional gate:
  // HARD gate = Daily + H4 + M15 only.
  // CONTEXT only = H1 + M30 + M5.
  const macroDir = macro.macroBias;

  const primaryTimeframes = {
    daily: timeframes.daily,
    h4: timeframes.h4,
    m15: timeframes.m15,
  };

  const contextTimeframes = {
    h1: timeframes.h1,
    m30: timeframes.m30,
    m5: timeframes.m5,
  };

  const primaryConflictingTimeframes = [];
  const contextConflictingTimeframes = [];

  if (macroDir !== 'ranging') {
    const opp = macroDir === 'bullish' ? 'bearish' : 'bullish';

    for (const [tfName, tfTrend] of Object.entries(primaryTimeframes)) {
      if (tfTrend === opp) primaryConflictingTimeframes.push(tfName);
    }

    for (const [tfName, tfTrend] of Object.entries(contextTimeframes)) {
      if (tfTrend === opp) contextConflictingTimeframes.push(tfName);
    }
  }

  // UI compatibility: hard conflicts only include Daily/H4/M15.
  const conflictingTimeframes = [...primaryConflictingTimeframes];

  // Primary timeframe alignment score: Daily + H4 + M15 are the decision gate.
  // H1 / M30 / M5 are context only and should not define the primary score.
  const primaryFrames = [timeframes.daily, timeframes.h4, timeframes.m15];
  const bullishPrimary = primaryFrames.filter((t) => t === 'bullish').length;
  const bearishPrimary = primaryFrames.filter((t) => t === 'bearish').length;
  const neutralPrimary = primaryFrames.filter((t) => !t || t === 'neutral' || t === 'ranging').length;

  let timeframeAlignmentScore = 0;
  if (macroDir === 'bullish') {
    timeframeAlignmentScore = Math.round((bullishPrimary / primaryFrames.length) * 100);
  } else if (macroDir === 'bearish') {
    timeframeAlignmentScore = Math.round((bearishPrimary / primaryFrames.length) * 100);
  } else {
    timeframeAlignmentScore = Math.round(((primaryFrames.length - neutralPrimary) / primaryFrames.length) * 50);
  }

  const rejectionReasons = [];

  // Alignment status
  let alignmentStatus = 'mixed';
  if (Math.abs(directional) > 0.7 && conflictingTimeframes.length <= 1) alignmentStatus = 'strong';
  else if (conflictingTimeframes.length >= 3)                            alignmentStatus = 'conflicting';

  if (macroDir === 'ranging') {
    rejectionReasons.push('Macro bias is ranging — no directional trade qualified');
  } else if (!momentum.executionSignal) {
    rejectionReasons.push('Momentum layer produced no execution signal');
  } else if (momentum.executionSignal !== (macroDir === 'bullish' ? 'long' : 'short')) {
    rejectionReasons.push(
      `Execution direction (${momentum.executionSignal}) opposes macro bias (${macroDir}) — countertrend not allowed`
    );
  }

  if (macro.macroConfidence < minMacroConfidence) {
    rejectionReasons.push(`Macro confidence ${macro.macroConfidence} < min ${minMacroConfidence}`);
  }
  if (structure.structuralConfidence < minStructuralConfidence) {
    rejectionReasons.push(`Structural confidence ${structure.structuralConfidence} < min ${minStructuralConfidence}`);
  }
  if (momentum.executionConfidence < minExecutionConfidence) {
    rejectionReasons.push(`Execution confidence ${momentum.executionConfidence} < min ${minExecutionConfidence}`);
  }
  const effectiveMinAlignmentScore = Math.max(minAlignmentScore, 67);

  if (timeframeAlignmentScore < effectiveMinAlignmentScore) {
    rejectionReasons.push(
      `Primary timeframe alignment failed: Daily + H4 + M15 score ${timeframeAlignmentScore}/100 < ${effectiveMinAlignmentScore}/100. H1/M30/M5 are context only.`
    );
  }

  if (primaryConflictingTimeframes.length > 0) {
    rejectionReasons.push(
      `Primary timeframe conflict: ${primaryConflictingTimeframes.join(', ')} opposes macro bias (${macroDir}). H1/M30/M5 are context only.`
    );
  }

  // H1/M30/M5 context conflicts are intentionally not hard rejection reasons.
  if (structure.reversalRisk === 'high') {
    rejectionReasons.push('Structure reversal risk is HIGH');
  }
  if (macro.volatilityRegime === 'compressed' && momentum.atrPips < 5) {
    rejectionReasons.push('Volatility compressed AND M15 ATR < 5p — flat market, low expected movement');
  }

  // Macro key-level proximity is already handled by the structure layer via
  // `structure.nearKeyLevel` + `structure.reversalRisk`. We intentionally don't
  // re-check M15 micro S/R here — those highs/lows are noise on a 20p / 60p
  // structure and would reject every trade.

  const tradeQualified = rejectionReasons.length === 0;

  return {
    timeframeAlignmentScore,
    alignmentStatus,
    dominantBias,
    conflictingTimeframes,
    primaryConflictingTimeframes,
    contextConflictingTimeframes,
    tradeQualified,
    rejectionReasons,
    timeframes,
    weights,
    directional: +directional.toFixed(3),
    minimums: {
      minMacroConfidence,
      minStructuralConfidence,
      minExecutionConfidence,
      minAlignmentScore,
      minRiskReward,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIDENCE AGGREGATOR
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Weighted multi-factor confidence (replaces the old indicator-driven calc).
 *
 *   macroConfidence       40%
 *   structuralConfidence  30%
 *   executionConfidence   20%
 *   alignmentScore        10%
 *
 * Then small adjustments for spread/session/volatility/news.
 *
 * Returns a single 0–100 number suitable for the existing dynamic-risk sizer.
 */
export function computeConfidenceScore({
  macro, structure, momentum, alignment,
  spreadPips, maxSpreadPips, session, newsRisk = 'none',
}) {
  let conf =
      0.40 * macro.macroConfidence
    + 0.30 * structure.structuralConfidence
    + 0.20 * momentum.executionConfidence
    + 0.10 * alignment.timeframeAlignmentScore;

  // Liquidity / session
  if (session === 'London/NewYork Overlap') conf += 4;
  else if (session === 'London' || session === 'NewYork') conf += 2;
  else if (session === 'Sydney' || session === 'Sydney/Tokyo Overlap') conf -= 12;
  else if (session === 'Tokyo') conf -= 4;

  // Spread quality
  if (maxSpreadPips && spreadPips !== undefined && spreadPips !== null) {
    const ratio = spreadPips / maxSpreadPips;
    if      (ratio <= 0.3) conf += 3;
    else if (ratio >  0.8) conf -= 3;
  }

  // Volatility
  if (macro.volatilityRegime === 'compressed') conf -= 6;
  if (macro.volatilityRegime === 'expanded')   conf += 2;

  // News risk
  if (newsRisk === 'high')   conf -= 15;
  if (newsRisk === 'medium') conf -= 5;

  return Math.max(0, Math.min(100, Math.round(conf)));
}
