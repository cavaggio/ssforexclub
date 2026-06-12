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

import { checkMargin, MARGIN_RESTRICTION_MESSAGE, computeOpenRiskUSD, computeOpenRiskPercent } from './riskManager.js';

export { checkMargin, MARGIN_RESTRICTION_MESSAGE, computeOpenRiskUSD, computeOpenRiskPercent };

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

// computeOpenRiskUSD / computeOpenRiskPercent are defined in riskManager.js
// (single source) and re-exported above.
