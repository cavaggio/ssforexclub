/**
 * server/oandaCandleStrength.js
 *
 * Candle-quality scoring. The legacy `candleConfirmation()` only returned
 * 'bullish' / 'bearish' / 'doji' — too coarse to distinguish a clean
 * directional close from a rejection wick that happens to be the same color.
 *
 *   analyzeCandleStrength({ candles, direction, pair, atrPips })
 *     → {
 *         candleStrengthScore: 0–100,
 *         classification: 'strong' | 'moderate' | 'weak' | 'rejection' | 'doji',
 *         components: {
 *           bodySize, range, upperWick, lowerWick,
 *           bodyToRange, closeStrength,           // 0–1 fractions
 *           wickRejectionRatio,                   // wick-on-rejection-side / body
 *           engulfing: 'bullish' | 'bearish' | 'none',
 *           expansionRatio,                       // body vs avg-body of prior 10 candles
 *           isCompressed, isExpanding,
 *         },
 *         penalty: number,                        // 0–60 deduction for poor structure
 *         reason: string
 *       }
 *
 * Scoring rules (sum, clamped to 0–100):
 *   +35  bodyToRange  ≥ 0.65            +20  body 0.50–0.65        +5   0.35–0.50
 *   +25  closeStrength ≥ 0.75           +12  0.60–0.75             +0   < 0.60
 *   +20  expansionRatio ≥ 1.20          +10  0.90–1.20             −10 ≤ 0.60
 *   +15  engulfing matches direction
 *   +5   no rejection wick on trade side
 *
 *   Penalty applied AFTER the sum:
 *     wickRejectionRatio ≥ 1.0  → score *= 0.4 (heavy)
 *     wickRejectionRatio ≥ 0.6  → score *= 0.7 (moderate)
 *     doji (bodyToRange < 0.15) → score = min(score, 25)
 *
 * Classification cutoffs:
 *   strong   ≥ 70
 *   moderate ≥ 45
 *   weak     ≥ 25
 *   rejection / doji  → flagged separately
 */

function pipSizeFor(pair) {
  if (String(pair || '').includes('JPY'))       return 0.01;
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return 0.01;
  if (String(pair || '').startsWith('NAS100') ||
      String(pair || '').startsWith('US30')   ||
      String(pair || '').startsWith('SPX500') ||
      String(pair || '').startsWith('DE30')   ||
      String(pair || '').startsWith('UK100')) return 1.0;
  return 0.0001;
}

function avgBody(prevCandles) {
  if (!prevCandles.length) return 0;
  const total = prevCandles.reduce((s, c) => s + Math.abs(c.close - c.open), 0);
  return total / prevCandles.length;
}

function avgRange(prevCandles) {
  if (!prevCandles.length) return 0;
  const total = prevCandles.reduce((s, c) => s + (c.high - c.low), 0);
  return total / prevCandles.length;
}

/**
 * @param {Object} args
 * @param {Array<{open:number,high:number,low:number,close:number}>} args.candles
 * @param {'long'|'short'} [args.direction]
 * @param {string} [args.pair]
 * @param {number} [args.atrPips]   optional, used only for compression detection
 */
export function analyzeCandleStrength({ candles, direction, pair, atrPips }) {
  if (!Array.isArray(candles) || candles.length < 2) {
    return {
      candleStrengthScore: 0,
      classification: 'doji',
      components: null,
      penalty: 0,
      reason: 'Insufficient candle data',
    };
  }

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const bodySize = Math.abs(last.close - last.open);
  const range    = last.high - last.low;
  if (range <= 0) {
    return {
      candleStrengthScore: 0,
      classification: 'doji',
      components: null,
      penalty: 0,
      reason: 'Zero-range candle',
    };
  }

  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const bodyToRange = bodySize / range;

  // closeStrength: how strong was the close towards the trade direction?
  // For longs, close near high is strong (1.0). For shorts, close near low.
  // Without a direction we compute both and take the dominant one.
  const closeStrengthLong  = (last.close - last.low)  / range;
  const closeStrengthShort = (last.high  - last.close) / range;
  const dir = direction === 'long' || direction === 'short'
    ? direction
    : (closeStrengthLong >= closeStrengthShort ? 'long' : 'short');
  const closeStrength = dir === 'long' ? closeStrengthLong : closeStrengthShort;

  // Wick on the REJECTION side — for longs, upper wick is the rejection.
  const rejectionWick = dir === 'long' ? upperWick : lowerWick;
  const wickRejectionRatio = bodySize > 0 ? rejectionWick / bodySize : 0;

  // Engulfing: last body fully contains prev body AND opposite color
  const lastBull = last.close > last.open;
  const prevBull = prev.close > prev.open;
  const engulfsPrev = Math.max(last.open, last.close) > Math.max(prev.open, prev.close) &&
                      Math.min(last.open, last.close) < Math.min(prev.open, prev.close);
  let engulfing = 'none';
  if (engulfsPrev && lastBull && !prevBull) engulfing = 'bullish';
  if (engulfsPrev && !lastBull && prevBull) engulfing = 'bearish';

  // Expansion vs compression — compare body to the prior 10 candle bodies.
  const priorWindow = candles.slice(-12, -1);
  const avgPriorBody  = avgBody(priorWindow);
  const avgPriorRange = avgRange(priorWindow);
  const expansionRatio = avgPriorBody > 0 ? bodySize / avgPriorBody : 1;
  // Compressed: avg range of prior 10 < 0.7 × ATR (if known)
  const pipSize = pipSizeFor(pair);
  const isCompressed = Number.isFinite(atrPips) && atrPips > 0 && avgPriorRange > 0
    ? (avgPriorRange / pipSize) < (atrPips * 0.7)
    : false;
  const isExpanding = expansionRatio >= 1.2;

  // Doji guard — body is tiny relative to range.
  const isDoji = bodyToRange < 0.15;

  // ── Score ────────────────────────────────────────────────────────────────
  let score = 0;
  if      (bodyToRange >= 0.65) score += 35;
  else if (bodyToRange >= 0.50) score += 20;
  else if (bodyToRange >= 0.35) score += 5;

  if      (closeStrength >= 0.75) score += 25;
  else if (closeStrength >= 0.60) score += 12;

  if      (expansionRatio >= 1.20) score += 20;
  else if (expansionRatio >= 0.90) score += 10;
  else if (expansionRatio <= 0.60) score -= 10;

  if ((dir === 'long'  && engulfing === 'bullish') ||
      (dir === 'short' && engulfing === 'bearish')) {
    score += 15;
  }
  if (rejectionWick <= bodySize * 0.25) score += 5;

  // ── Penalties ────────────────────────────────────────────────────────────
  let penalty = 0;
  if (wickRejectionRatio >= 1.0) { score *= 0.40; penalty = 60; }
  else if (wickRejectionRatio >= 0.6) { score *= 0.70; penalty = 30; }
  if (isDoji) { score = Math.min(score, 25); }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let classification;
  if (isDoji)                                  classification = 'doji';
  else if (wickRejectionRatio >= 1.0)          classification = 'rejection';
  else if (score >= 70)                        classification = 'strong';
  else if (score >= 45)                        classification = 'moderate';
  else                                          classification = 'weak';

  // ── Reason string ────────────────────────────────────────────────────────
  const parts = [];
  parts.push(`body ${(bodyToRange * 100).toFixed(0)}% of range`);
  parts.push(`close ${(closeStrength * 100).toFixed(0)}% to ${dir === 'long' ? 'high' : 'low'}`);
  if (expansionRatio >= 1.2) parts.push(`${expansionRatio.toFixed(2)}× expansion`);
  if (expansionRatio <= 0.6) parts.push(`${expansionRatio.toFixed(2)}× compression`);
  if (engulfing !== 'none')  parts.push(`${engulfing} engulfing`);
  if (wickRejectionRatio >= 0.6) parts.push(`rejection wick ${wickRejectionRatio.toFixed(2)}× body`);
  if (isDoji) parts.push('doji body');
  const reason = `${classification} candle: ${parts.join(', ')}`;

  return {
    candleStrengthScore: score,
    classification,
    direction: dir,
    components: {
      bodySize: +bodySize.toFixed(6),
      range:    +range.toFixed(6),
      upperWick: +upperWick.toFixed(6),
      lowerWick: +lowerWick.toFixed(6),
      bodyToRange: +bodyToRange.toFixed(3),
      closeStrength: +closeStrength.toFixed(3),
      wickRejectionRatio: +wickRejectionRatio.toFixed(3),
      engulfing,
      expansionRatio: +expansionRatio.toFixed(3),
      isCompressed,
      isExpanding,
    },
    penalty,
    reason,
  };
}

/**
 * Helper: roll up candle strength across a small window (last 3 candles) so
 * a single noisy bar can't qualify a trade and a single doji can't kill one.
 */
export function analyzeRecentCandleStrength({ candles, direction, pair, atrPips, window = 3 }) {
  if (!Array.isArray(candles) || candles.length < window + 1) {
    return analyzeCandleStrength({ candles, direction, pair, atrPips });
  }
  // Score the last candle (weight 0.6), the prior (0.3), and the one before (0.1)
  const weights = [0.6, 0.3, 0.1];
  const slices = [];
  for (let i = 0; i < window; i++) {
    const upToIdx = candles.length - i; // slice end (exclusive)
    slices.push(analyzeCandleStrength({
      candles: candles.slice(0, upToIdx),
      direction, pair, atrPips,
    }));
  }
  const rolling = slices.reduce((sum, s, i) => sum + s.candleStrengthScore * weights[i], 0);
  const last = slices[0];
  return {
    ...last,
    candleStrengthScore: Math.round(rolling),
    rollingWindowScore: Math.round(rolling),
    perCandle: slices.map((s, i) => ({
      offset: -i,
      score: s.candleStrengthScore,
      classification: s.classification,
    })),
  };
}
