// Centralized execution policy for June 23 restore logic.

export const TRADE_DECISION_POLICY = {
  minConfidence: 90,
  minRR: 1.5,
  maxDailyLossPercent: 2.5,
  requireStructureConfirmation: true,
  requireLiquidityConfirmation: true,
  requireExpectedRRConfirmation: true,
  requirePremiumDiscountConfirmation: true,
};

export function dailyLossPercent(startingBalance, currentBalance) {
  const start = Number(startingBalance || 0);
  const current = Number(currentBalance || 0);
  if (!start || !current) return 0;
  return Math.max(0, ((start - current) / start) * 100);
}

export function scoreSoftFilters(candidate = {}) {
  let adjustment = 0;

  if (candidate.regimeAligned === true) adjustment += 1;
  if (candidate.regimeAligned === false) adjustment -= 1;

  if (candidate.liquidityIntentStrong === true) adjustment += 2;
  if (candidate.liquidityIntentStrong === false) adjustment -= 1;

  if (candidate.calibrationPositive === true) adjustment += 1;
  if (candidate.calibrationPositive === false) adjustment -= 1;

  if (candidate.smtDivergence === true) adjustment += 1;
  if (candidate.sessionNarrativeAligned === true) adjustment += 1;

  return adjustment;
}

export function finalConfidence(candidate = {}) {
  const base = Number(candidate.confidence ?? 0);
  return Math.max(0, Math.min(100, base + scoreSoftFilters(candidate)));
}

export function evaluateTradeCandidate(candidate = {}, account = {}) {
  const confidence = finalConfidence(candidate);
  const rr = Number(candidate.rr ?? candidate.riskReward ?? candidate.expectedRR ?? 0);

  const lossPct = dailyLossPercent(
    account.startingDailyBalance ?? account.startingBalance,
    account.currentBalance ?? account.balance
  );

  if (lossPct >= TRADE_DECISION_POLICY.maxDailyLossPercent) {
    return {
      allowed: false,
      reason: `Daily loss ${lossPct.toFixed(2)}% hit max ${TRADE_DECISION_POLICY.maxDailyLossPercent}%. Trading stopped.`,
      confidence,
      rr,
    };
  }

  if (confidence < TRADE_DECISION_POLICY.minConfidence) {
    return {
      allowed: false,
      reason: `Confidence ${confidence}% below required ${TRADE_DECISION_POLICY.minConfidence}%.`,
      confidence,
      rr,
    };
  }

  if (rr < TRADE_DECISION_POLICY.minRR) {
    return {
      allowed: false,
      reason: `RR ${rr} below required ${TRADE_DECISION_POLICY.minRR}.`,
      confidence,
      rr,
    };
  }

  if (!candidate.structureConfirmed) {
    return { allowed: false, reason: "Structure confirmation missing.", confidence, rr };
  }

  if (!candidate.liquidityConfirmed) {
    return { allowed: false, reason: "Liquidity confirmation missing.", confidence, rr };
  }

  if (!candidate.expectedRRConfirmed) {
    return { allowed: false, reason: "Expected RR confirmation missing.", confidence, rr };
  }

  if (!candidate.premiumDiscountConfirmed) {
    return { allowed: false, reason: "Premium/discount confirmation missing.", confidence, rr };
  }

  return {
    allowed: true,
    reason: "Approved by June 23 restored decision policy.",
    confidence,
    rr,
  };
}
