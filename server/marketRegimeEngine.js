/**
 * server/marketRegimeEngine.js
 *
 * Signal Stack V3 — Market Regime Detection (ADDITIVE, read-only).
 *
 *   detectMarketRegime({ pair, candles, indicators, signal }) → regime envelope
 *
 * Classifies the current environment into one of:
 *   TRENDING_BULLISH | TRENDING_BEARISH | RANGING |
 *   VOLATILITY_EXPANSION | VOLATILITY_COMPRESSION | TRANSITIONAL
 *
 * Uses ONLY inputs the scanner already computes (ATR, EMA alignment, RSI,
 * price structure, volatility regime, trend strength). It reads them from the
 * `signal` object first (the richest source in the waterfall), falling back to
 * an explicit `indicators` bag or raw `candles` when called standalone.
 *
 * IMPORTANT — this is purely informational. It is appended onto signals as
 * `signal.marketRegime` for the dashboard and analytics. It NEVER changes
 * scoring, qualification, sizing, or active-trade decisions.
 *
 * Returns:
 *   {
 *     regime: <one of the six above>,
 *     confidence: number (0–100),
 *     volatility: { state: 'compressed'|'normal'|'expanded', atrPips: number|null, label: string },
 *     recommendation: string,
 *     avoid: boolean        // true when the regime is hostile to clean entries
 *   }
 */

const REGIMES = {
  TRENDING_BULLISH: 'TRENDING_BULLISH',
  TRENDING_BEARISH: 'TRENDING_BEARISH',
  RANGING: 'RANGING',
  VOLATILITY_EXPANSION: 'VOLATILITY_EXPANSION',
  VOLATILITY_COMPRESSION: 'VOLATILITY_COMPRESSION',
  TRANSITIONAL: 'TRANSITIONAL',
};

// ─── Input extraction (defensive — any field may be missing) ─────────────────

function pick(...vals) {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return null;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function gatherInputs({ candles, indicators, signal }) {
  const s = signal || {};
  const macro = s.macro || {};
  const momentum = s.momentum || {};
  const structure = s.structure || {};
  const ind = indicators || {};

  const volatilityRegime = String(
    pick(ind.volatilityRegime, macro.volatilityRegime, s.volatilityState, 'normal'),
  ).toLowerCase();

  const trendStrength = num(pick(ind.trendStrength, s.trendStrength, macro.trendStrength)) ?? null;

  const emaAlignment = String(
    pick(ind.emaAlignment, s.emaAlignment, momentum.m15Alignment, macro.h4Alignment, 'mixed'),
  ).toLowerCase();

  const rsi = num(pick(ind.rsi, s.rsi, momentum.rsi));

  const atrPips = num(pick(ind.atrPips, s.atrPips, momentum.atrPips, macro.atrPips));

  // Price-structure label, normalised to a small vocabulary.
  const structureType = String(
    pick(ind.structureType, macro?.marketStructure?.type, s?.marketStructure?.type, ''),
  ).toLowerCase();

  // m15/daily directional trend ('bullish'|'bearish'|'neutral')
  const microTrend = String(pick(ind.trend, s.trend, momentum.m15Trend, macro.dailyTrend, 'neutral')).toLowerCase();

  // Optional, only used as a tie-breaker when present.
  const marketState = String(pick(ind.marketState, s.marketState, '')).toUpperCase();

  return {
    volatilityRegime,
    trendStrength,
    emaAlignment,
    rsi,
    atrPips,
    structureType,
    microTrend,
    marketState,
    hasCandles: Array.isArray(candles) && candles.length > 0,
  };
}

function isTrendingStructure(structureType) {
  return structureType.startsWith('trending') || structureType.includes('breakout') || structureType.includes('impulse');
}
function isRangingStructure(structureType) {
  return structureType.includes('consolidat') || structureType.includes('range') || structureType.includes('choppy');
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function detectMarketRegime({ pair, candles, indicators, signal } = {}) {
  const i = gatherInputs({ candles, indicators, signal });

  const volatility = {
    state: ['compressed', 'expanded', 'normal'].includes(i.volatilityRegime) ? i.volatilityRegime : 'normal',
    atrPips: i.atrPips,
    label: '',
  };
  volatility.label =
    volatility.state === 'expanded' ? 'Volatility expanding'
    : volatility.state === 'compressed' ? 'Volatility compressed'
    : 'Normal volatility';

  const reasons = [];
  const trendStrong = i.trendStrength != null && i.trendStrength >= 60;
  const trendWeak = i.trendStrength != null && i.trendStrength <= 35;
  const bullishAlign = i.emaAlignment.includes('bull') || i.microTrend === 'bullish';
  const bearishAlign = i.emaAlignment.includes('bear') || i.microTrend === 'bearish';

  let regime;
  let confidence = 50;

  // 1) Volatility compression dominates — coiled market, breakout pending.
  if (volatility.state === 'compressed' && !trendStrong) {
    regime = REGIMES.VOLATILITY_COMPRESSION;
    confidence = 65;
    reasons.push('ATR/volatility compressed with no strong trend — coiled, breakout pending.');
  }
  // 2) Volatility expansion without a clean directional structure — chop/whipsaw.
  else if (volatility.state === 'expanded' && !isTrendingStructure(i.structureType) && !trendStrong) {
    regime = REGIMES.VOLATILITY_EXPANSION;
    confidence = 62;
    reasons.push('Volatility expanding without a clean trend structure — elevated whipsaw risk.');
  }
  // 3) Clean bullish trend.
  else if ((trendStrong || isTrendingStructure(i.structureType)) && bullishAlign && !bearishAlign) {
    regime = REGIMES.TRENDING_BULLISH;
    confidence = 70 + (trendStrong ? 12 : 0);
    reasons.push('EMA alignment bullish with supportive trend strength / structure.');
  }
  // 4) Clean bearish trend.
  else if ((trendStrong || isTrendingStructure(i.structureType)) && bearishAlign && !bullishAlign) {
    regime = REGIMES.TRENDING_BEARISH;
    confidence = 70 + (trendStrong ? 12 : 0);
    reasons.push('EMA alignment bearish with supportive trend strength / structure.');
  }
  // 5) Ranging — weak trend with ranging structure or RSI hovering mid-band.
  else if (isRangingStructure(i.structureType) || (trendWeak && i.emaAlignment === 'mixed')) {
    regime = REGIMES.RANGING;
    confidence = 60;
    reasons.push('Weak/absent trend with ranging structure — mean-reversion environment.');
  }
  // 6) Everything else — mixed signals, regime in flux.
  else {
    regime = REGIMES.TRANSITIONAL;
    confidence = 45;
    reasons.push('Mixed trend/volatility signals — regime in transition.');
  }

  // RSI extremes nuance confidence for trend regimes (overextension risk).
  if (i.rsi != null) {
    if (regime === REGIMES.TRENDING_BULLISH && i.rsi >= 78) {
      confidence = Math.max(40, confidence - 12);
      reasons.push(`RSI ${Math.round(i.rsi)} overbought — trend may be overextended.`);
    } else if (regime === REGIMES.TRENDING_BEARISH && i.rsi <= 22) {
      confidence = Math.max(40, confidence - 12);
      reasons.push(`RSI ${Math.round(i.rsi)} oversold — trend may be overextended.`);
    }
  }

  // Volatility expansion overlaps a trend → still tradeable but flag the chop risk.
  if (volatility.state === 'expanded' &&
      (regime === REGIMES.TRENDING_BULLISH || regime === REGIMES.TRENDING_BEARISH)) {
    reasons.push('Trend running into expanding volatility — wider stops / partial sizing advised.');
  }

  confidence = Math.max(0, Math.min(100, Math.round(confidence)));

  const avoid =
    regime === REGIMES.TRANSITIONAL ||
    regime === REGIMES.VOLATILITY_EXPANSION ||
    (regime === REGIMES.RANGING && confidence < 65);

  const recommendation = buildRecommendation(regime, volatility, avoid);

  return {
    regime,
    confidence,
    volatility,
    recommendation,
    avoid,
    reasons,
    // Inputs echoed for transparency / debugging in the dashboard.
    inputs: {
      trendStrength: i.trendStrength,
      emaAlignment: i.emaAlignment,
      rsi: i.rsi,
      atrPips: i.atrPips,
      structureType: i.structureType || null,
    },
  };
}

function buildRecommendation(regime, volatility, avoid) {
  switch (regime) {
    case REGIMES.TRENDING_BULLISH:
      return 'Bullish trend regime — favour pullback longs and trend-continuation setups; fade counter-trend signals.';
    case REGIMES.TRENDING_BEARISH:
      return 'Bearish trend regime — favour pullback shorts and trend-continuation setups; fade counter-trend signals.';
    case REGIMES.RANGING:
      return avoid
        ? 'Choppy range — low conviction. Prefer range edges only; avoid mid-range entries and breakout chasing.'
        : 'Range regime — trade the edges (buy support / sell resistance), keep targets modest, avoid mid-range.';
    case REGIMES.VOLATILITY_EXPANSION:
      return 'Volatility expansion — whipsaw risk is high. Widen stops, reduce size, and demand strong confirmation.';
    case REGIMES.VOLATILITY_COMPRESSION:
      return 'Volatility compression — market coiled. Anticipate a breakout; wait for it to resolve rather than pre-positioning.';
    case REGIMES.TRANSITIONAL:
    default:
      return 'Transitional regime — signals are mixed. Lower conviction; wait for the environment to clarify.';
  }
}

export { REGIMES };
