/**
 * server/oandaCalibration.js
 *
 * Self-improvement layer for Signal Stack. Reads the resolved trade history,
 * aggregates monthly Expected-RR vs Realized-R, and derives a calibrated
 * rejection threshold the scanner uses in place of the static 1.75.
 *
 * The idea: if the platform consistently realises only 60-70% of projected
 * reward, tighten qualification automatically so we stop accepting trades
 * whose realistic capture is below the user's target RR. Calibration tightens
 * the rejection threshold when capture is poor, loosens it back toward the
 * default when capture matches projection, and stays put inside the deadband
 * to avoid threshold thrash.
 *
 * Pure module — no I/O, no env reads, no broker credentials. The reassessor
 * / scanner pass in the trade-history array and the engine returns a stable
 * snapshot.
 */

import { RR_TIER_THRESHOLDS } from './oandaExpectedRR.js';

const DEFAULT_REJECTION_THRESHOLD = RR_TIER_THRESHOLDS.reject; // 1.75
const MIN_SAMPLES_FOR_ADJUST = 10;     // need at least this many resolved trades
const LOOKBACK_TRADES = 60;            // weight recent trades, ignore ancient
const WIDE_THRESHOLD_MAX = 3.0;        // never tighten past this in one pass
const WIDE_THRESHOLD_MIN = 1.5;        // never loosen below this

const finite = (n, fb = 0) => (Number.isFinite(n) ? n : fb);
const round = (n, places = 2) => {
  const p = 10 ** places;
  return Math.round(n * p) / p;
};

// ─── Per-trade math ──────────────────────────────────────────────────────────

/**
 * Compute the realised R-multiple for a resolved trade.
 *   realizedR = pnl_usd / riskAmount_usd
 * Win at exactly TP (1:3) → ~+3R; SL hit → ~-1R; partial close anywhere
 * between. Returns null when inputs don't permit a sensible computation.
 */
export function computeRealizedR(trade) {
  if (!trade) return null;
  if (trade.result !== 'win' && trade.result !== 'loss' && trade.result !== 'manual_close') {
    return null;
  }
  const pnl = finite(trade.pnl, NaN);
  const risk = finite(trade.riskAmount, NaN);
  if (!Number.isFinite(pnl) || !Number.isFinite(risk) || risk <= 0) return null;
  return round(pnl / risk, 2);
}

/**
 * "Expected RR" the platform projected at entry time. Prefers the
 * calibrated `expectedRR` (Signal Stack V3 field) if present; falls back
 * to the geometric `entryRiskRewardRatio` for older history rows.
 */
export function getExpectedRR(trade) {
  if (Number.isFinite(trade?.expectedRR)) return trade.expectedRR;
  if (Number.isFinite(trade?.entryRiskRewardRatio)) return trade.entryRiskRewardRatio;
  if (Number.isFinite(trade?.riskReward)) return trade.riskReward;
  return null;
}

// ─── Monthly aggregation ─────────────────────────────────────────────────────

function monthKey(isoTimestamp) {
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Group resolved trades by month and compute Expected-RR vs Realized-R.
 *
 * Returns:
 *   [
 *     {
 *       month: '2026-05',
 *       sampleCount,
 *       avgExpectedRR,
 *       avgRealizedR,
 *       winRate,           // 0..1
 *       captureRatio,      // realised / expected (signed; negative when net losses)
 *     },
 *     …
 *   ]
 * sorted oldest → newest.
 */
export function aggregateMonthlyRR(trades) {
  const buckets = new Map();
  for (const t of trades ?? []) {
    const expected = getExpectedRR(t);
    const realized = computeRealizedR(t);
    if (expected == null || realized == null) continue;
    const key = monthKey(t.timestamp ?? t.entryAt ?? new Date().toISOString());
    if (!key) continue;
    const b = buckets.get(key) ?? {
      month: key,
      sumExpected: 0,
      sumRealized: 0,
      wins: 0,
      sampleCount: 0,
    };
    b.sumExpected += expected;
    b.sumRealized += realized;
    if (t.result === 'win') b.wins += 1;
    b.sampleCount += 1;
    buckets.set(key, b);
  }
  return Array.from(buckets.values())
    .map((b) => ({
      month: b.month,
      sampleCount: b.sampleCount,
      avgExpectedRR: b.sampleCount ? round(b.sumExpected / b.sampleCount, 2) : 0,
      avgRealizedR: b.sampleCount ? round(b.sumRealized / b.sampleCount, 2) : 0,
      winRate: b.sampleCount ? round(b.wins / b.sampleCount, 2) : 0,
      captureRatio: b.sumExpected > 0 ? round(b.sumRealized / b.sumExpected, 2) : 0,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * Rolling weighted capture ratio over the most-recent `LOOKBACK_TRADES`
 * resolved trades. This is the input to threshold derivation — it's more
 * stable than a single month's bucket and avoids cliff effects on the 1st
 * of every month.
 */
export function computeRollingCapture(trades) {
  const resolved = (trades ?? [])
    .filter((t) => {
      const r = computeRealizedR(t);
      const e = getExpectedRR(t);
      return r != null && e != null;
    })
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, LOOKBACK_TRADES);
  if (!resolved.length) {
    return { sampleCount: 0, sumExpected: 0, sumRealized: 0, captureRatio: null };
  }
  let sumExpected = 0;
  let sumRealized = 0;
  for (const t of resolved) {
    sumExpected += getExpectedRR(t);
    sumRealized += computeRealizedR(t);
  }
  const captureRatio = sumExpected > 0 ? round(sumRealized / sumExpected, 2) : 0;
  return {
    sampleCount: resolved.length,
    sumExpected: round(sumExpected, 2),
    sumRealized: round(sumRealized, 2),
    avgExpectedRR: round(sumExpected / resolved.length, 2),
    avgRealizedR: round(sumRealized / resolved.length, 2),
    captureRatio,
  };
}

// ─── Threshold derivation ────────────────────────────────────────────────────

/**
 * Map a rolling capture ratio to an effective rejection threshold. The
 * function is monotonic-decreasing in capture: worse capture → higher
 * threshold (fewer trades qualify but each is more conservative).
 *
 *   captureRatio ≥ 0.95 → 1.75   (default — system is calibrated)
 *   0.85-0.95           → 1.85
 *   0.75-0.85           → 2.00
 *   0.65-0.75           → 2.15   (user's "60-70% → tighten" band)
 *   0.55-0.65           → 2.30
 *   < 0.55              → 2.50   (aggressive tighten — projections broken)
 *   < 0                 → 2.50   (net loss period — same aggressive tighten)
 *
 * Capped at WIDE_THRESHOLD_MAX so a single very-bad month can't lock the
 * scanner into "no trades ever qualify".
 */
export function thresholdForCaptureRatio(captureRatio) {
  if (captureRatio == null || !Number.isFinite(captureRatio)) {
    return DEFAULT_REJECTION_THRESHOLD;
  }
  if (captureRatio >= 0.95) return 1.75;
  if (captureRatio >= 0.85) return 1.85;
  if (captureRatio >= 0.75) return 2.00;
  if (captureRatio >= 0.65) return 2.15;
  if (captureRatio >= 0.55) return 2.30;
  return Math.min(WIDE_THRESHOLD_MAX, 2.50);
}

/**
 * Produce a calibration snapshot for the scanner + UI. Falls back to the
 * default threshold when sample size is too small for a stable adjustment.
 */
export function getCalibrationSnapshot(trades) {
  const monthly = aggregateMonthlyRR(trades);
  const rolling = computeRollingCapture(trades);

  const eligible = rolling.sampleCount >= MIN_SAMPLES_FOR_ADJUST;
  const rawThreshold = eligible
    ? thresholdForCaptureRatio(rolling.captureRatio)
    : DEFAULT_REJECTION_THRESHOLD;
  const calibratedRejectionThreshold = Math.max(
    WIDE_THRESHOLD_MIN,
    Math.min(WIDE_THRESHOLD_MAX, rawThreshold),
  );

  const adjustmentReason = (() => {
    if (!eligible) {
      return `Insufficient history (${rolling.sampleCount}/${MIN_SAMPLES_FOR_ADJUST} resolved trades) — using default threshold ${DEFAULT_REJECTION_THRESHOLD}.`;
    }
    const cr = rolling.captureRatio;
    if (cr >= 0.95) return `Capture ratio ${cr} — system calibrated, default threshold applies.`;
    if (cr >= 0.85) return `Capture ratio ${cr} — slight tighten (threshold ${calibratedRejectionThreshold}).`;
    if (cr >= 0.65) return `Capture ratio ${cr} — projections overshooting; tightened to ${calibratedRejectionThreshold} so qualifying trades clear a higher bar.`;
    return `Capture ratio ${cr} — projections significantly above realised; aggressive tighten to ${calibratedRejectionThreshold}.`;
  })();

  return {
    monthly,
    rolling,
    defaultRejectionThreshold: DEFAULT_REJECTION_THRESHOLD,
    calibratedRejectionThreshold,
    eligibleForAdjustment: eligible,
    minSamplesForAdjust: MIN_SAMPLES_FOR_ADJUST,
    lookbackTrades: LOOKBACK_TRADES,
    adjustmentReason,
    computedAt: new Date().toISOString(),
  };
}
