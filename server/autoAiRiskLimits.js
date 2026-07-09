/**
 * server/autoAiRiskLimits.js
 *
 * Auto AI portfolio-level risk: the TOTAL open-risk cap that bounds how much
 * concurrent risk the autonomous path may carry across all open positions.
 *
 *   - Max total open Auto AI risk  AUTO_AI_MAX_TOTAL_OPEN_RISK_PERCENT (4.5%)
 *
 * Per-trade risk, margin, the daily drawdown lock, and the auto-confidence floor
 * are NOT defined here — they live in the central server/riskManager.js so every
 * engine shares one implementation (hardening requirement #6). checkMargin and
 * MARGIN_RESTRICTION_MESSAGE are re-exported from riskManager for back-compat.
 */

import { checkMargin, MARGIN_RESTRICTION_MESSAGE } from './riskManager.js';

export { checkMargin, MARGIN_RESTRICTION_MESSAGE };

// Small epsilon so floating-point sizing is not rejected at the exact cap.
const EPS = 1e-9;

export function autoAiRiskConfig() {
  return {
    maxTotalOpenRiskPercent: parseFloat(process.env.AUTO_AI_MAX_TOTAL_OPEN_RISK_PERCENT || '4.5'),
  };
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
 * Estimate the total open risk (USD) across the broker's currently-open trades.
 *
 * For each open trade we approximate risk as |units| × |entryPrice − stopLoss|.
 * This is exact for USD-quoted pairs (EUR_USD, GBP_USD, …) and a reasonable
 * proxy otherwise. Trades with no protective stop contribute 0.
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
