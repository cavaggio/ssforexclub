import { getAccountSummary } from './oandaMarketData.js';

export const QUALIFIED_MANUAL_RISK_PERCENT = 1.25;

export function targetRiskUsdFromBalance(balanceUSD, riskPercent = QUALIFIED_MANUAL_RISK_PERCENT) {
  const balance = Number(balanceUSD);
  const percent = Number(riskPercent);
  if (!Number.isFinite(balance) || balance <= 0) {
    throw new Error('Cannot derive manual execution risk from an invalid account balance.');
  }
  if (!Number.isFinite(percent) || percent <= 0 || percent > QUALIFIED_MANUAL_RISK_PERCENT) {
    throw new Error(`Manual execution risk percent must be between 0 and ${QUALIFIED_MANUAL_RISK_PERCENT}.`);
  }
  return +((balance * percent) / 100).toFixed(2);
}

/**
 * Resolve the qualified manual-trade dollar risk on the trusted Railway side.
 * Browser payloads never choose the amount. The active request-scoped OANDA
 * account balance is authoritative and every qualified manual order receives the
 * platform's fixed 1.25% target before it reaches an engine executor.
 */
export async function deriveQualifiedManualRisk({
  client,
  getAccount = null,
  riskPercent = QUALIFIED_MANUAL_RISK_PERCENT,
} = {}) {
  if (!client) throw new Error('Missing request-scoped OANDA client for manual risk derivation.');
  const readAccount = getAccount || (() => getAccountSummary({ client }));
  const account = await readAccount();
  const balanceUSD = Number(account?.balance);
  const targetRiskUSD = targetRiskUsdFromBalance(balanceUSD, riskPercent);
  return {
    balanceUSD,
    targetRiskUSD,
    riskPercent,
    currency: String(account?.currency || 'USD'),
    source: 'server_account_balance',
  };
}

export function validateQualifiedManualTargetRisk({ targetRiskUSD, balanceUSD } = {}) {
  const target = Number(targetRiskUSD);
  const expected = targetRiskUsdFromBalance(balanceUSD);
  const tolerance = 0.01;
  return {
    allowed: Number.isFinite(target) && target > 0 && Math.abs(target - expected) <= tolerance,
    targetRiskUSD: expected,
    requestedTargetRiskUSD: Number.isFinite(target) ? target : null,
    riskPercent: QUALIFIED_MANUAL_RISK_PERCENT,
    reason: Number.isFinite(target) && Math.abs(target - expected) <= tolerance
      ? null
      : `Qualified manual execution risk must equal ${QUALIFIED_MANUAL_RISK_PERCENT}% of the active account balance ($${expected.toFixed(2)}).`,
  };
}
