import { executeTrade } from './oandaTrade.js';
import { validateV3ExecutionSignal } from './v3ExecutionBoundary.js';

/**
 * Dedicated V3 broker handoff.
 *
 * V3 strategy qualification ends before this module calls shared OANDA
 * infrastructure. Shared code may enforce account risk, margin, spread,
 * duplicate protection, sizing, and atomic order submission, but it may not
 * source or alter V3 direction, score, Stage 1, Stage 2, stop, target, or entry.
 */

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

export async function executeV3Trade(signal, { client } = {}) {
  const boundary = validateV3ExecutionSignal(signal);
  if (!boundary.allowed) {
    return reject(`V3 execution boundary rejected: ${boundary.reasons.join('; ')}`);
  }

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
