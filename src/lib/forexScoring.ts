/**
 * src/lib/forexScoring.ts
 * Frontend companion to the backend scoring engine.
 * Provides display helpers for confidence breakdown, color coding,
 * and human-readable labels. Does NOT generate or modify signals.
 */

import type { ForexSignal, ForexScoreBreakdown } from '../types/forex.ts';

// ─── Confidence breakdown (display only) ─────────────────────────────────────

export interface ConfidenceBreakdown {
  timeframeAlignment: number;  // 0-20 pts
  indicatorAgreement: number;  // 0-20 pts
  spreadQuality: number;       // 0-15 pts
  volatilityQuality: number;   // 0-15 pts (low ATR penalized for intraday)
  trendClarity: number;        // 0-15 pts
  candleStrength: number;      // 0-10 pts
  sessionQuality: number;      // 0-5 pts (London/NY weighted higher; Sydney/Asian penalized)
  total: number;               // 0-100
}

/**
 * Derive a display-only confidence breakdown from a qualified signal.
 * Mirrors backend weighting for UI explanation — does not regenerate the signal.
 */
export function deriveConfidenceBreakdown(signal: ForexSignal): ConfidenceBreakdown {
  const sb: ForexScoreBreakdown = signal.scoreBreakdown;

  const timeframeAlignment =
    signal.emaAlignment !== 'mixed' && signal.trend !== 'neutral'
      ? 20
      : signal.emaAlignment !== 'mixed' || signal.trend !== 'neutral'
      ? 12
      : 5;

  const indicatorAgreement = Math.round(
    (((sb.rsi ?? 0) / 2 + (sb.macd ?? 0) / 2 + (sb.trend ?? 0) / 2) / 3) * 20
  );

  const spreadQuality =
    signal.spreadPips <= 0.8 ? 15
    : signal.spreadPips <= 1.5 ? 10
    : signal.spreadPips <= 2.0 ? 5
    : 0;

  const volatilityQuality = (sb.atr ?? 0) === 2 ? 15 : (sb.atr ?? 0) === 1 ? 8 : 0;

  const trendClarity =
    (sb.trend ?? 0) === 2 && (sb.emaAlignment ?? 0) === 2 ? 15
    : (sb.trend ?? 0) === 2 ? 8
    : 0;

  const candleStrength = (sb.candleConfirmation ?? 0) === 2 ? 10 : (sb.candleConfirmation ?? 0) === 1 ? 5 : 0;

  const sessionQuality = (sb.session ?? 0) === 2 ? 5 : (sb.session ?? 0) === 1 ? 2 : 0;

  const total = Math.min(
    100,
    timeframeAlignment + indicatorAgreement + spreadQuality + volatilityQuality + trendClarity + candleStrength + sessionQuality
  );

  return { timeframeAlignment, indicatorAgreement, spreadQuality, volatilityQuality, trendClarity, candleStrength, sessionQuality, total };
}

// ─── Color helpers ────────────────────────────────────────────────────────────

/** Color for a 0-2 factor score. */
export function scoreFactorColor(score: number): string {
  if (score === 2) return '#2dff7a';
  if (score === 1) return '#ffcc00';
  return '#ff4d4d';
}

/** Color for a confidence percentage. */
export function confidenceColor(confidence: number): string {
  if (confidence >= 85) return '#2dff7a';
  if (confidence >= 70) return '#ffcc00';
  return '#ff8c00';
}

/** Color for a signal score out of 20. */
export function signalScoreColor(score: number): string {
  if (score >= 17) return '#2dff7a';
  if (score >= 15) return '#ffcc00';
  return '#ff8c00';
}

// ─── Label helpers ────────────────────────────────────────────────────────────

/** Human-readable confidence level label. */
export function confidenceLabel(confidence: number): string {
  if (confidence >= 90) return 'Very High';
  if (confidence >= 80) return 'High';
  if (confidence >= 70) return 'Moderate';
  if (confidence >= 60) return 'Low';
  return 'Very Low';
}

/** Human-readable signal age string (e.g. "2m 30s ago"). */
export function signalAgeLabel(ageSeconds: number | null): string {
  if (ageSeconds === null) return 'No data';
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  const mins = Math.floor(ageSeconds / 60);
  const secs = ageSeconds % 60;
  return secs > 0 ? `${mins}m ${secs}s ago` : `${mins}m ago`;
}

/** Human-readable risk:reward display. */
export function rrLabel(rr: number): string {
  return `1:${rr.toFixed(2)}`;
}

/** Display pair as EUR/USD instead of EUR_USD. */
export function formatPair(pair: string): string {
  return pair.replace('_', '/');
}

// ─── Score breakdown labels ───────────────────────────────────────────────────

const FACTOR_LABELS: Record<string, string> = {
  trend: 'H1 Trend Direction',
  emaAlignment: 'EMA Stack Alignment',
  rsi: 'RSI Momentum',
  macd: 'MACD Continuation',
  atr: 'ATR Volatility Expansion',
  spread: 'Spread Quality',
  session: 'Session Liquidity',
  newsRisk: 'News Risk',
  mtfAlignment: 'MTF Alignment (M5/H1/H4)',
  srProximity: 'S/R Proximity',
  candleConfirmation: 'Candle / Wick Pattern',
  marketStructure: 'Market Structure',
};

export function factorLabel(key: string): string {
  return FACTOR_LABELS[key] ?? key.replace(/([A-Z])/g, ' $1').trim();
}

// ─── Pair quality ranking ─────────────────────────────────────────────────────

export interface PairQualityScore {
  pair: string;
  spreadScore: number;   // 0-100
  overallScore: number;  // 0-100
}

/**
 * Rank pairs by display quality (spread tightness).
 * Mirrors the backend pair-ranking logic for UI ordering.
 */
export function rankPairsByQuality(
  signals: Array<{ pair: string; spreadPips: number; score: number }>
): PairQualityScore[] {
  return signals
    .map((s) => ({
      pair: s.pair,
      spreadScore: Math.max(0, 100 - s.spreadPips * 30),
      overallScore: Math.round(s.score / 20 * 70 + Math.max(0, 100 - s.spreadPips * 30) * 0.3),
    }))
    .sort((a, b) => b.overallScore - a.overallScore);
}
