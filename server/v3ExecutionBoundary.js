import { validateDirectionLock } from './v3EntryContract.js';

/**
 * Pure V3 execution contract. This module has no broker, ICT, PPR, scheduler,
 * scanner, or shared execution imports, so it can be tested independently.
 */

export const V3_FOREIGN_STRATEGY_FIELDS = Object.freeze([
  'ict',
  'ictSignal',
  'ictSignalId',
  'ppr',
  'pprSignal',
  'legacyDirection',
  'directionAgrees',
  'legacyCandidate',
]);

export function validateV3ExecutionSignal(signal = {}) {
  const reasons = [];

  if (signal?.engine !== 'v3') reasons.push('engine must equal v3');
  if (signal?.architecture !== 'independent_v3_raw_market_data') {
    reasons.push('architecture must equal independent_v3_raw_market_data');
  }
  if (signal?.selectedLogicType !== 'v3_pure') reasons.push('selectedLogicType must equal v3_pure');
  if (!signal?.v3 || signal.v3.engine !== 'v3') reasons.push('native V3 analysis payload is required');
  if (signal?.qualityConfirmation?.stage1?.allowed !== true) reasons.push('V3 Stage 1 must pass');
  if (signal?.qualityConfirmation?.stage2?.allowed !== true) reasons.push('V3 Stage 2 must pass');

  const directionLock = validateDirectionLock({
    candidateDirection: signal?.direction,
    confirmedDirection:
      signal?.directionLock?.confirmedDirection ||
      signal?.qualityConfirmation?.stage2?.metrics?.lockedDirection,
    freshDirection:
      signal?.directionLock?.freshDirection ||
      signal?.qualityConfirmation?.stage2?.metrics?.direction,
  });
  if (!directionLock.allowed) reasons.push(...directionLock.reasons);

  for (const field of V3_FOREIGN_STRATEGY_FIELDS) {
    if (signal?.[field] !== undefined && signal?.[field] !== null) {
      reasons.push(`foreign strategy field is forbidden: ${field}`);
    }
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    directionLock,
    engine: 'v3',
    architecture: 'independent_v3_raw_market_data',
  };
}
