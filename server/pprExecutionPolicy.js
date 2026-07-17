const MANIPULATION_TYPES = new Set([
  'liquidity_raid',
  'fvg_mitigation',
  'order_block_retest',
]);

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
  const manipulationTypes = Array.isArray(confirmation.manipulationTypes)
    ? confirmation.manipulationTypes.join('+')
    : confirmation.manipulationType || 'none';
  return [
    accountId || 'default',
    'ppr',
    signal?.pair || signal?.instrument || 'unknown',
    signal?.direction || 'none',
    confirmation.dailyBias || 'none',
    confirmation.session || 'none',
    manipulationTypes,
    manipulation.entryReferencePrice ?? manipulation.level ?? manipulation.zoneLow ?? 'na',
    target.price ?? 'na',
    confirmation.confirmedAt || signal?.generatedAt || 'na',
  ].join('|');
}

function confirmedManipulationTypes(confirmation = {}) {
  const listed = Array.isArray(confirmation.manipulationTypes)
    ? confirmation.manipulationTypes
    : [confirmation.manipulationType];
  return [...new Set(listed.map((value) => String(value || '')).filter((value) => MANIPULATION_TYPES.has(value)))];
}

/**
 * PPR-only final policy. This module deliberately imports no legacy, V3, or ICT
 * analysis or entry-contract code.
 */
export function evaluatePprExecutionPolicy(signal = {}, {
  minRR = 1.5,
  maxEntryDistancePips = 12,
} = {}) {
  const reasons = [];
  const confirmation = signal?.pprConfirmation || {};
  const expectedBias = directionBias(signal?.direction);
  const rr = Number(signal?.expectedRR ?? signal?.rr);
  const manipulationTypes = confirmedManipulationTypes(confirmation);
  const distancePips = Number(
    confirmation.manipulationDistancePips ??
    signal?.ppr?.manipulation?.distancePips,
  );

  if (!isPprExecutionSignal(signal)) reasons.push('signal is not marked as PPR');
  if (confirmation.allowed !== true) reasons.push('PPR confirmation is not allowed');
  if (!expectedBias) reasons.push('PPR direction must be long or short');
  if (expectedBias && confirmation.dailyBias !== expectedBias) {
    reasons.push(`Daily EMA9 bias ${confirmation.dailyBias || 'missing'} does not match ${signal.direction}`);
  }
  if (confirmation.dailyEma !== 9) reasons.push('PPR Daily EMA must be EMA9');
  if (confirmation.h1Ema !== 9 || confirmation.h1EmaAligned !== true) {
    reasons.push('PPR H1 EMA9 execution alignment is not confirmed');
  }
  if (confirmation.volumeSpike !== true) reasons.push('PPR M5 tick-volume spike is not confirmed');
  if (!manipulationTypes.length) {
    reasons.push('PPR misdirection must include a liquidity raid, FVG mitigation, or order-block retest');
  }
  if (!['London', 'London_to_New_York', 'New_York_AM'].includes(String(confirmation.session || ''))) {
    reasons.push('PPR session confirmation is outside London-to-New-York AM');
  }
  if (!Number.isFinite(distancePips) || distancePips > maxEntryDistancePips) {
    reasons.push(`PPR entry is more than ${maxEntryDistancePips} pips from valid manipulation/retest`);
  }
  if (!Number.isFinite(rr) || rr < minRR) {
    reasons.push(`PPR executable R:R ${Number.isFinite(rr) ? rr : 'n/a'} is below ${minRR}`);
  }
  if (!Number.isFinite(Number(signal?.stopLoss)) || !Number.isFinite(Number(signal?.takeProfit))) {
    reasons.push('PPR stop loss or take profit is missing');
  }
  if (signal?.lifecycle?.source !== 'ppr_native_geometry') {
    reasons.push('PPR lifecycle must originate from PPR native geometry');
  }
  if (signal?.lifecycle?.management?.automatedManagement !== false) {
    reasons.push('PPR automated trade management must remain disabled');
  }
  if (
    signal?.lifecycle?.management?.cutoffEt !== '10:00' ||
    signal?.lifecycle?.management?.afterCutoff !== 'manual_only'
  ) {
    reasons.push('PPR management must stop at 10:00 ET and become manual-only');
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    engine: 'ppr',
    expectedBias,
    manipulationType: confirmation.manipulationType || null,
    manipulationTypes,
    session: confirmation.session || null,
    distancePips: Number.isFinite(distancePips) ? distancePips : null,
    rr: Number.isFinite(rr) ? rr : null,
    managementCutoffEt: '10:00',
    afterCutoff: 'manual_only',
  };
}
