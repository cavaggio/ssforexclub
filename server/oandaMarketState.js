/**
 * server/oandaMarketState.js
 *
 * Composite market-state classifier. Sits on top of the existing waterfall
 * (macro + structure + momentum) and folds in raw candle metrics to label
 * the current regime with a single name:
 *
 *   TRENDING         — clean directional move on H1/H4 with EMA alignment + structure
 *   RANGING          — bracketed price action, no clean break, EMAs flat
 *   VOLATILE         — ATR > 1.5× historical AND no clean trend (whippy)
 *   LOW_LIQUIDITY    — Asian session OR ATR < 0.6× historical, wide spreads
 *   BREAKOUT         — range broken in the last 1-3 bars with expansion candle
 *   REVERSAL_RISK    — counter-trend close at HTF level, opposing momentum
 *   CHOPPY           — high candle overlap, lots of wick activity, no follow-through
 *
 * Each state implies different gating rules — see `allowedSetups` on the
 * return value. The lifecycle and scanner use these to widen SL, narrow TP,
 * or reject continuation trades outright.
 *
 *   classifyMarketState({ macro, structure, momentum, candlesM15, candlesH1, session })
 *     → {
 *         marketState,
 *         marketStateScore,   // 0–100 confidence in the label
 *         marketStateReason,
 *         allowedSetups: ['continuation', 'reversal', 'breakout', 'mean_reversion'],
 *         rules: {                              // suggestions consumed by lifecycle
 *           slMultiplierMin, slMultiplierMax,
 *           tpMultiplierMin, tpMultiplierMax,
 *           confidencePenalty,                  // applied to aggregate confidence
 *           rejectContinuation,                 // hard reject for late continuation
 *         }
 *       }
 */

function asPct(x) { return Math.max(0, Math.min(100, Math.round(x))); }

function countCandleOverlap(candles, window = 10) {
  // Two consecutive candles "overlap" when their bodies share a price range.
  // High overlap → choppy / ranging.
  if (!Array.isArray(candles) || candles.length < window + 1) return 0;
  const slice = candles.slice(-window - 1);
  let overlaps = 0;
  for (let i = 1; i < slice.length; i++) {
    const a = slice[i - 1], b = slice[i];
    const aLo = Math.min(a.open, a.close), aHi = Math.max(a.open, a.close);
    const bLo = Math.min(b.open, b.close), bHi = Math.max(b.open, b.close);
    if (Math.max(aLo, bLo) <= Math.min(aHi, bHi)) overlaps++;
  }
  return overlaps / (slice.length - 1); // 0..1
}

function countWickFraction(candles, window = 12) {
  // Fraction of recent candles where the total wick > total body
  if (!Array.isArray(candles) || candles.length < window) return 0;
  const slice = candles.slice(-window);
  let wicky = 0;
  for (const c of slice) {
    const body = Math.abs(c.close - c.open);
    const wick = (c.high - c.low) - body;
    if (wick > body) wicky++;
  }
  return wicky / slice.length;
}

function isExpansionCandle(candle, prevCandles, atrPriceUnits) {
  if (!candle || !prevCandles?.length || !atrPriceUnits) return false;
  const body = Math.abs(candle.close - candle.open);
  const avgPriorBody = prevCandles.reduce((s, c) => s + Math.abs(c.close - c.open), 0) / prevCandles.length;
  return body >= atrPriceUnits * 0.5 && body >= avgPriorBody * 1.5;
}

const LOW_LIQUIDITY_SESSIONS = new Set([
  'Sydney', 'Sydney/Tokyo Overlap', 'Tokyo',
]);

export function classifyMarketState({
  macro, structure, momentum, candlesM15, candlesH1, session,
}) {
  // Defensive defaults
  const macroBias       = macro?.macroBias        ?? 'ranging';
  const structureType   = macro?.marketStructure?.type ?? 'unknown';
  const volRegime       = macro?.volatilityRegime ?? 'normal';
  const atrPips         = macro?.atrPips          ?? 0;
  const atrPipsHist     = macro?.atrPipsHistorical ?? 0;
  const reversalRisk    = structure?.reversalRisk ?? 'low';
  const trendStrength   = macro?.trendStrength    ?? 0;
  const dailyTrend      = macro?.dailyTrend       ?? 'neutral';
  const h4Trend         = macro?.h4Trend          ?? 'neutral';
  const h1Trend         = structure?.h1Trend      ?? 'neutral';
  const m15Trend        = momentum?.m15Trend      ?? 'neutral';
  const hasBOS          = !!macro?.marketStructure?.hasBOS;

  // Raw structural metrics
  const overlapM15 = countCandleOverlap(candlesM15, 10);
  const overlapH1  = countCandleOverlap(candlesH1, 10);
  const wickFracM15 = countWickFraction(candlesM15, 12);

  // ─── Rule-based classifier ─────────────────────────────────────────────────
  let marketState = 'TRENDING';
  let score = 0;
  let reason = '';
  let allowedSetups = ['continuation'];
  let rules = {
    slMultiplierMin: 1.0,
    slMultiplierMax: 1.6,
    tpMultiplierMin: 2.0,
    tpMultiplierMax: 3.0,
    confidencePenalty: 0,
    rejectContinuation: false,
  };

  // 1. LOW_LIQUIDITY — Asian session or very compressed ATR
  if (LOW_LIQUIDITY_SESSIONS.has(session) || (atrPipsHist > 0 && atrPips / atrPipsHist < 0.6)) {
    marketState = 'LOW_LIQUIDITY';
    score = 75;
    reason = LOW_LIQUIDITY_SESSIONS.has(session)
      ? `${session} session — historically low liquidity`
      : `ATR ${atrPips}p is ${((atrPips / atrPipsHist) * 100).toFixed(0)}% of historical (${atrPipsHist}p) — compressed`;
    allowedSetups = ['mean_reversion'];
    rules = {
      slMultiplierMin: 0.8, slMultiplierMax: 1.2,
      tpMultiplierMin: 1.2, tpMultiplierMax: 2.0,
      confidencePenalty: 15,
      rejectContinuation: false,   // ranging is allowed if mean-reversion strict
    };
    return { marketState, marketStateScore: score, marketStateReason: reason, allowedSetups, rules };
  }

  // 2. VOLATILE — ATR > 1.5× historical AND no clean directional trend (vote split)
  const voteSplit = (dailyTrend !== 'neutral' && h4Trend !== 'neutral' && dailyTrend !== h4Trend);
  if (atrPipsHist > 0 && atrPips / atrPipsHist >= 1.5 && (macroBias === 'ranging' || voteSplit)) {
    marketState = 'VOLATILE';
    score = 80;
    reason = `ATR ${atrPips}p is ${((atrPips / atrPipsHist) * 100).toFixed(0)}% of historical — high volatility without clean direction`;
    allowedSetups = ['breakout', 'reversal'];
    rules = {
      slMultiplierMin: 1.4, slMultiplierMax: 2.4,    // wider SL
      tpMultiplierMin: 1.8, tpMultiplierMax: 3.0,
      confidencePenalty: 10,
      rejectContinuation: true,
    };
    return { marketState, marketStateScore: score, marketStateReason: reason, allowedSetups, rules };
  }

  // 3. BREAKOUT — H4 BOS + last bar is expansion + structure agrees
  const lastM15 = candlesM15?.[candlesM15.length - 1];
  const priorM15 = candlesM15?.slice(-12, -1) || [];
  const atrPriceUnits = atrPips && lastM15
    ? atrPips * ((lastM15.high - lastM15.low) > 1 ? 0.01 : 0.0001)
    : null;
  const m15Expansion = isExpansionCandle(lastM15, priorM15, atrPriceUnits);
  if (hasBOS && m15Expansion && macroBias !== 'ranging') {
    marketState = 'BREAKOUT';
    score = 78;
    reason = `H4 break of structure (${macroBias}) confirmed by M15 expansion candle`;
    allowedSetups = ['breakout', 'continuation'];
    rules = {
      slMultiplierMin: 1.2, slMultiplierMax: 1.8,
      tpMultiplierMin: 2.5, tpMultiplierMax: 4.0,
      confidencePenalty: 0,
      rejectContinuation: false,
    };
    return { marketState, marketStateScore: score, marketStateReason: reason, allowedSetups, rules };
  }

  // 4. REVERSAL_RISK — structure layer says high, or H1 opposes macro
  if (reversalRisk === 'high' || (macroBias !== 'ranging' &&
      ((macroBias === 'bullish' && h1Trend === 'bearish') ||
       (macroBias === 'bearish' && h1Trend === 'bullish')))) {
    marketState = 'REVERSAL_RISK';
    score = 70;
    reason = reversalRisk === 'high'
      ? 'Structure layer reports HIGH reversal risk (near unbroken HTF level)'
      : `H1 (${h1Trend}) opposes ${macroBias} macro — counter-trend pressure`;
    allowedSetups = ['reversal'];
    rules = {
      slMultiplierMin: 1.3, slMultiplierMax: 2.0,
      tpMultiplierMin: 1.5, tpMultiplierMax: 2.5,
      confidencePenalty: 20,
      rejectContinuation: true,            // late continuation REJECTED here
    };
    return { marketState, marketStateScore: score, marketStateReason: reason, allowedSetups, rules };
  }

  // 5. CHOPPY — high candle overlap + wicky bars + no clear macro direction
  if (overlapM15 >= 0.6 && wickFracM15 >= 0.55 && macroBias === 'ranging') {
    marketState = 'CHOPPY';
    score = 72;
    reason = `M15 overlap ${(overlapM15 * 100).toFixed(0)}%, wick fraction ${(wickFracM15 * 100).toFixed(0)}% — no follow-through`;
    allowedSetups = [];                    // nothing qualifies
    rules = {
      slMultiplierMin: 1.5, slMultiplierMax: 2.5,
      tpMultiplierMin: 1.0, tpMultiplierMax: 2.0,
      confidencePenalty: 30,
      rejectContinuation: true,
    };
    return { marketState, marketStateScore: score, marketStateReason: reason, allowedSetups, rules };
  }

  // 6. RANGING — macro ranging, structure consolidating
  if (macroBias === 'ranging' || structureType === 'consolidation') {
    marketState = 'RANGING';
    score = 65;
    reason = `Macro is ${macroBias}, H4 structure is ${structureType} — bracketed price action`;
    allowedSetups = ['mean_reversion', 'breakout'];
    rules = {
      slMultiplierMin: 0.9, slMultiplierMax: 1.4,
      tpMultiplierMin: 1.2, tpMultiplierMax: 2.0,
      confidencePenalty: 15,
      rejectContinuation: true,
    };
    return { marketState, marketStateScore: score, marketStateReason: reason, allowedSetups, rules };
  }

  // 7. TRENDING (default when nothing else fires)
  const baseTrendScore = 50 +
    (trendStrength * 0.3) +
    (m15Trend === macroBias ? 10 : 0) +
    (h1Trend === macroBias ? 10 : 0);
  marketState = 'TRENDING';
  score = asPct(baseTrendScore);
  reason =
    `Macro ${macroBias} (strength ${trendStrength}/100), structure ${structureType}, ` +
    `H1 ${h1Trend} / M15 ${m15Trend} aligned`;
  allowedSetups = ['continuation', 'breakout'];
  rules = {
    slMultiplierMin: 1.0, slMultiplierMax: 1.6,
    tpMultiplierMin: 2.0, tpMultiplierMax: 3.5,
    confidencePenalty: 0,
    rejectContinuation: false,
  };

  return { marketState, marketStateScore: score, marketStateReason: reason, allowedSetups, rules };
}
