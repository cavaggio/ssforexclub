/**
 * server/autoAiRiskLimits.js
 *
 * Auto AI risk protection — the single source of truth for the hard risk caps
 * that bound autonomous (Auto AI) execution. These are SEPARATE from the
 * advisory-only portfolioRiskEngine (which never gates a trade): the functions
 * here are consulted in the Auto AI execution path and can block an order.
 *
 *   - Max risk per trade        AUTO_AI_MAX_RISK_PER_TRADE_PERCENT   (default 1.5%)
 *   - Max total open Auto AI risk AUTO_AI_MAX_TOTAL_OPEN_RISK_PERCENT (default 4.5%)
 *   - Margin: never place a trade whose required margin exceeds available margin
 *     (do not bypass the broker's own margin restrictions).
 *
 * Config is read at call time (via autoAiRiskConfig) so tests can override env
 * per-case and there is one source of truth for both engines (ICT and V3).
 */

// Exact operator-facing message required when a margin restriction would be hit.
export const MARGIN_RESTRICTION_MESSAGE = 'Account margin restriction would be exceeded.';

// Small epsilon so floating-point sizing (e.g. exactly 1.5%) is not rejected.
const EPS = 1e-9;

export function autoAiRiskConfig() {
  return {
    maxRiskPerTradePercent: parseFloat(process.env.AUTO_AI_MAX_RISK_PER_TRADE_PERCENT || '1.5'),
    maxTotalOpenRiskPercent: parseFloat(process.env.AUTO_AI_MAX_TOTAL_OPEN_RISK_PERCENT || '4.5'),
  };
}

/**
 * Validate (and report) a single trade's intended risk against the per-trade cap.
 * Returns { allowed, riskPercent, maxRiskPercent, reason? }.
 */
export function checkPerTradeRisk(requestedRiskPercent, cfg = autoAiRiskConfig()) {
  const max = cfg.maxRiskPerTradePercent;
  if (!Number.isFinite(requestedRiskPercent) || requestedRiskPercent <= 0) {
    return { allowed: false, maxRiskPercent: max, reason: 'Invalid risk-per-trade percent' };
  }
  if (requestedRiskPercent > max + EPS) {
    return {
      allowed: false,
      riskPercent: requestedRiskPercent,
      maxRiskPercent: max,
      reason: `Risk per trade ${requestedRiskPercent}% exceeds Auto AI max ${max}%`,
    };
  }
  return { allowed: true, riskPercent: requestedRiskPercent, maxRiskPercent: max };
}

/**
 * Clamp a requested per-trade risk percent down to the Auto AI cap. Used when
 * sizing so the engine never sends an order risking more than the cap.
 */
export function capPerTradeRiskPercent(requestedRiskPercent, cfg = autoAiRiskConfig()) {
  const max = cfg.maxRiskPerTradePercent;
  if (!Number.isFinite(requestedRiskPercent) || requestedRiskPercent <= 0) return max;
  return Math.min(requestedRiskPercent, max);
}

/**
 * Check whether adding a new trade keeps total open Auto AI risk within the cap.
 * Returns { allowed, projectedTotal, maxTotalOpenRiskPercent, reason? }.
 */
export function checkTotalOpenRisk(currentOpenRiskPercent, newTradeRiskPercent, cfg = autoAiRiskConfig()) {
  const max = cfg.maxTotalOpenRiskPercent;
  const current = Number.isFinite(currentOpenRiskPercent) ? Math.max(0, currentOpenRiskPercent) : 0;
  const next = Number.isFinite(newTradeRiskPercent) ? Math.max(0, newTradeRiskPercent) : 0;
  const projectedTotal = +(current + next).toFixed(4);
  if (projectedTotal > max + EPS) {
    return {
      allowed: false,
      projectedTotal,
      maxTotalOpenRiskPercent: max,
      reason: `Total open Auto AI risk ${projectedTotal.toFixed(2)}% would exceed max ${max}%`,
    };
  }
  return { allowed: true, projectedTotal, maxTotalOpenRiskPercent: max };
}

/**
 * Margin guard. A trade is blocked when its estimated required margin exceeds
 * the broker-reported available margin (or either figure is unusable). This is
 * additive to the broker's own INSUFFICIENT_MARGIN rejection — it never bypasses
 * a broker restriction, it refuses earlier.
 * Returns { allowed, reason? } where reason is MARGIN_RESTRICTION_MESSAGE.
 */
export function checkMargin({ marginAvailable, estimatedMargin } = {}) {
  const avail = Number(marginAvailable);
  const req = Number(estimatedMargin);
  if (!Number.isFinite(avail) || !Number.isFinite(req) || req < 0) {
    return { allowed: false, reason: MARGIN_RESTRICTION_MESSAGE };
  }
  if (req > avail + EPS) {
    return { allowed: false, reason: MARGIN_RESTRICTION_MESSAGE };
  }
  return { allowed: true };
}

/**
 * Estimate the total open risk (USD) across the broker's currently-open trades.
 *
 * For each open trade we approximate risk as |units| × |entryPrice − stopLoss|.
 * This is exact for USD-quoted pairs (EUR_USD, GBP_USD, …) and a reasonable
 * proxy otherwise — consistent with the tolerant model used elsewhere. Trades
 * with no protective stop contribute 0 (their risk is unbounded but not
 * quantifiable here; the per-trade margin/sizing gates still apply on entry).
 *
 * Accepts raw OANDA open-trade objects (price, currentUnits, stopLossOrder.price).
 */
export function computeOpenRiskUSD(openTrades = []) {
  let total = 0;
  for (const t of Array.isArray(openTrades) ? openTrades : []) {
    if (!t || typeof t !== 'object') continue;
    const units = Math.abs(Number(t.currentUnits ?? t.units ?? t.tradeUnits ?? 0));
    const entry = Number(t.price ?? t.entryPrice ?? 0);
    const slPrice = Number(t.stopLossOrder?.price ?? t.stopLoss ?? t.slPrice ?? NaN);
    const explicitRisk = Number(t.riskUSD ?? t.actualRiskUSD ?? t.riskAmount ?? NaN);
    if (Number.isFinite(explicitRisk) && explicitRisk > 0) {
      total += explicitRisk;
      continue;
    }
    if (!units || !Number.isFinite(entry) || !Number.isFinite(slPrice)) continue;
    total += units * Math.abs(entry - slPrice);
  }
  return +total.toFixed(2);
}

/**
 * Total open risk as a percent of account balance/equity. Returns null when
 * balance is unusable so callers can decide how conservative to be.
 */
export function computeOpenRiskPercent(openTrades, balanceUSD) {
  const balance = Number(balanceUSD);
  if (!Number.isFinite(balance) || balance <= 0) return null;
  return +((computeOpenRiskUSD(openTrades) / balance) * 100).toFixed(4);
}
