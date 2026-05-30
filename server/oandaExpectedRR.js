/**
 * server/oandaExpectedRR.js
 *
 * Expected-R qualification layer. Folds the geometric R:R produced by the
 * lifecycle SL/TP engine with quality factors (confidence, alignment, trend
 * strength, market state, institutional flow, volatility regime) into a
 * single realistic `expectedRR` — the answer to:
 *
 *   "Given this setup's quality, what RR can we realistically expect to
 *    capture, not just what RR is geometrically possible?"
 *
 * Output:
 *   { expectedRiskPips, expectedRewardPips, expectedRR, rrTier, accepted, rejectionReason }
 *
 * Tier policy (Signal Stack V3):
 *   expectedRR < 1.75       → reject
 *   1.75 ≤ RR < 2.25        → standard
 *   2.25 ≤ RR < 3.5         → preferred
 *   RR ≥ 3.5                → premium
 *
 * Pure function. No I/O. No env reads. Trivially unit-testable.
 */

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const finite = (n, fb = 0) => (Number.isFinite(n) ? n : fb);

export const RR_TIER_THRESHOLDS = {
  reject:    1.75,
  preferred: 2.25,
  premium:   3.5,
};

export function classifyRRTier(expectedRR) {
  if (!Number.isFinite(expectedRR) || expectedRR < RR_TIER_THRESHOLDS.reject) return 'reject';
  if (expectedRR < RR_TIER_THRESHOLDS.preferred) return 'standard';
  if (expectedRR < RR_TIER_THRESHOLDS.premium) return 'preferred';
  return 'premium';
}

/**
 * Compute expected-R given a candidate signal + the lifecycle SL/TP output.
 *
 * @param {Object} ctx
 * @param {number} ctx.stopLossPips      — lifecycle SL distance
 * @param {number} ctx.takeProfitPips    — lifecycle TP distance
 * @param {number} ctx.confidence        — 0-100 (aggregated)
 * @param {number} ctx.alignmentScore    — 0-100
 * @param {number} ctx.trendStrength     — 0-100
 * @param {string} ctx.volatilityRegime  — 'compressed' | 'normal' | 'expanded'
 * @param {string} ctx.marketState       — current market state label
 * @param {string[]} [ctx.allowedMarketStates] — per-instrument profile
 * @param {Object} [ctx.institutionalFlow] — { detected, direction }
 * @param {string} ctx.direction         — 'long' | 'short'
 * @param {number} [ctx.candleStrengthScore] — 0-100
 *
 * @returns {{
 *   expectedRiskPips: number,
 *   expectedRewardPips: number,
 *   expectedRR: number,
 *   rrTier: 'reject'|'standard'|'preferred'|'premium',
 *   qualityFactor: number,
 *   accepted: boolean,
 *   rejectionReason: string|null,
 *   factors: Record<string, number>,
 * }}
 */
export function computeExpectedRR(ctx) {
  const stopLossPips   = finite(ctx.stopLossPips, 0);
  const takeProfitPips = finite(ctx.takeProfitPips, 0);
  if (stopLossPips <= 0 || takeProfitPips <= 0) {
    return {
      expectedRiskPips: stopLossPips,
      expectedRewardPips: takeProfitPips,
      expectedRR: 0,
      rrTier: 'reject',
      qualityFactor: 0,
      accepted: false,
      rejectionReason: `Invalid SL/TP distances (sl=${stopLossPips}, tp=${takeProfitPips})`,
      factors: {},
    };
  }
  const geometricRR = takeProfitPips / stopLossPips;

  // ── Quality factors ──────────────────────────────────────────────────────
  // Confidence sets the base — high-confidence setups capture closer to their
  // geometric RR; low-confidence setups give back edge to slippage/spread/
  // momentum stall.
  const confidence = clamp(finite(ctx.confidence, 50), 0, 100);
  const confidenceFactor = 0.55 + 0.45 * (confidence / 100);     // 0.55..1.00

  // Alignment: 0..100 → 0.8..1.05.
  const alignment = clamp(finite(ctx.alignmentScore, 60), 0, 100);
  const alignmentFactor = 0.8 + 0.25 * (alignment / 100);

  // Trend strength: rewards strong trends, neutral around 50, penalises chop.
  const trend = clamp(finite(ctx.trendStrength, 50), 0, 100);
  const trendFactor = trend >= 75 ? 1.10 : trend >= 50 ? 1.0 : 0.85;

  // Institutional flow agreement: small but meaningful boost when flow aligns.
  const flowMatches =
    ctx.institutionalFlow?.detected &&
    ctx.institutionalFlow.direction === (ctx.direction === 'long' ? 'bullish' : 'bearish');
  const flowOpposes =
    ctx.institutionalFlow?.detected &&
    ctx.institutionalFlow.direction !== 'neutral' &&
    ctx.institutionalFlow.direction !== (ctx.direction === 'long' ? 'bullish' : 'bearish');
  const flowFactor = flowMatches ? 1.05 : flowOpposes ? 0.85 : 1.0;

  // Market-state allowance: penalise if the trade is happening in a state the
  // instrument profile flagged as disallowed.
  const stateAllowed = (ctx.allowedMarketStates ?? []).length === 0 ||
    (ctx.allowedMarketStates ?? []).includes(ctx.marketState);
  const stateFactor = stateAllowed ? 1.0 : 0.7;

  // Volatility regime: compressed markets struggle to deliver full TP;
  // expanded markets often overshoot but also reverse — keep it neutral
  // unless explicitly compressed.
  const volFactor = ctx.volatilityRegime === 'compressed' ? 0.85
                  : ctx.volatilityRegime === 'expanded'   ? 1.05
                  : 1.0;

  // Candle strength (entry quality at the bar level).
  const candle = clamp(finite(ctx.candleStrengthScore, 50), 0, 100);
  const candleFactor = 0.9 + 0.2 * (candle / 100);                // 0.9..1.10

  const qualityFactor = clamp(
    confidenceFactor * alignmentFactor * trendFactor *
      flowFactor * stateFactor * volFactor * candleFactor,
    0.3, 1.25,
  );

  // ── Expected output ──────────────────────────────────────────────────────
  // Risk doesn't change — the SL is the SL. Reward is what realistically gets
  // captured given the quality factor.
  const expectedRiskPips   = +stopLossPips.toFixed(1);
  const expectedRewardPips = +(takeProfitPips * qualityFactor).toFixed(1);
  const expectedRR         = +(geometricRR * qualityFactor).toFixed(2);
  const rrTier             = classifyRRTier(expectedRR);
  const accepted           = rrTier !== 'reject';
  const rejectionReason    = accepted
    ? null
    : `Expected RR ${expectedRR} below minimum ${RR_TIER_THRESHOLDS.reject} ` +
      `(geometric ${geometricRR.toFixed(2)} × quality ${qualityFactor.toFixed(2)})`;

  return {
    expectedRiskPips,
    expectedRewardPips,
    expectedRR,
    rrTier,
    qualityFactor: +qualityFactor.toFixed(3),
    accepted,
    rejectionReason,
    factors: {
      geometricRR: +geometricRR.toFixed(2),
      confidenceFactor: +confidenceFactor.toFixed(3),
      alignmentFactor:  +alignmentFactor.toFixed(3),
      trendFactor,
      flowFactor,
      stateFactor,
      volFactor,
      candleFactor: +candleFactor.toFixed(3),
    },
  };
}
