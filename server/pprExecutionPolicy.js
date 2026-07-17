const MANIPULATION_TYPES = new Set(['liquidity_raid', 'fvg_mitigation', 'order_block_retest']);

function directionBias(direction) {
  if (direction === 'long') return 'bullish';
  if (direction === 'short') return 'bearish';
  return null;
}

export function isPprExecutionSignal(signal = {}) {
  return (
    signal?.engine === 'ppr' ||
    String(signal?.strategy || '').toUpperCase() === 'PPR' ||
    signal?.source === 'ppr_auto_ai' ||
    signal?.selectedLogicType === 'ppr_native'
  );
}

export function pprSetupFingerprint(signal = {}, accountId = '') {
  const confirmation = signal?.pprConfirmation || {};
  const manipulation = signal?.ppr?.manipulation || {};
  const target = signal?.ppr?.liquidityTarget || {};
  return [
    accountId || 'default',
    'ppr',
    signal?.pair || signal?.instrument || 'unknown',
    signal?.direction || 'none',
    confirmation.dailyBias || 'none',
    confirmation.session || 'none',
    confirmation.manipulationType || 'none',
    manipulation.level ?? manipulation.zoneLow ?? 'na',
    target.price ?? 'na',
    confirmation.confirmedAt || signal?.generatedAt || 'na',
  ].join('|');
}

/**
 * PPR-only final policy. This module deliberately imports no legacy, V3, or ICT
 * analysis or entry-contract code.
 */
export function evaluatePprExecutionPolicy(signal = {}, { minRR = 1.5 } = {}) {
  const reasons = [];
  const confirmation = signal?.pprConfirmation || {};
  const expectedBias = directionBias(signal?.direction);
  const rr = Number(signal?.expectedRR ?? signal?.rr);

  if (!isPprExecutionSignal(signal)) reasons.push('signal is not marked as PPR');
  if (confirmation.allowed !== true) reasons.push('PPR confirmation is not allowed');
  if (!expectedBias) reasons.push('PPR direction must be long or short');
  if (expectedBias && confirmation.dailyBias !== expectedBias) {
    reasons.push(`Daily EMA bias ${confirmation.dailyBias || 'missing'} does not match ${signal.direction}`);
  }
  if (confirmation.volumeSpike !== true) reasons.push('PPR M5 volume/liquidity spike is not confirmed');
  if (!MANIPULATION_TYPES.has(String(confirmation.manipulationType || ''))) {
    reasons.push('PPR manipulation must be a liquidity raid, FVG mitigation, or order-block retest');
  }
  if (!['London', 'London_to_New_York', 'New_York_AM'].includes(String(confirmation.session || ''))) {
    reasons.push('PPR session confirmation is outside London-to-New-York AM');
  }
  if (!Number.isFinite(rr) || rr < minRR) reasons.push(`PPR executable R:R ${Number.isFinite(rr) ? rr : 'n/a'} is below ${minRR}`);
  if (!Number.isFinite(Number(signal?.stopLoss)) || !Number.isFinite(Number(signal?.takeProfit))) {
    reasons.push('PPR stop loss or take profit is missing');
  }
  if (signal?.lifecycle?.source !== 'ppr_native_geometry') {
    reasons.push('PPR lifecycle must originate from PPR native geometry');
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    engine: 'ppr',
    expectedBias,
    manipulationType: confirmation.manipulationType || null,
    session: confirmation.session || null,
    rr: Number.isFinite(rr) ? rr : null,
  };
}
