import { executeTrade } from './oandaTrade.js';
import { validateDirectionLock } from './v3EntryContract.js';

/**
 * Dedicated V3 execution boundary.
 *
 * V3 strategy qualification ends here. The downstream OANDA module is shared
 * only for broker transport, account/risk limits, duplicate protection, sizing,
 * and atomic order submission. It is not allowed to source or alter V3 strategy
 * direction, score, Stage 1, Stage 2, stop, target, or entry geometry.
 */

const FOREIGN_STRATEGY_FIELDS = Object.freeze([
  'ict',
  'ictSignal',
  'ictSignalId',
  'ppr',
  'pprSignal',
  'legacyDirection',
  'directionAgrees',
  'legacyCandidate',
]);

function reject(reason) {
  return {
    success: false,
    blocked: true,
    executionState: 'REJECTED',
    reason,
    rejectReason: reason,
    engine: 'v3',
  };
}

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

  for (const field of FOREIGN_STRATEGY_FIELDS) {
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

export async function executeV3Trade(signal, { client } = {}) {
  const boundary = validateV3ExecutionSignal(signal);
  if (!boundary.allowed) {
    return reject(`V3 execution boundary rejected: ${boundary.reasons.join('; ')}`);
  }

  // Shared OANDA code is used as infrastructure only. The signal has already
  // passed the V3-native setup, trigger, direction-lock, and geometry contract.
  return executeTrade(
    {
      ...signal,
      engine: 'v3',
      strategy: 'V3',
      selectedLogicType: 'v3_pure',
      architecture: 'independent_v3_raw_market_data',
    },
    { client, autoAi: true },
  );
}
