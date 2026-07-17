import { refreshIndependentV3CandidateForExecution } from './v3IndependentScanner.js';
import { executeTrade } from './oandaTrade.js';
import { applyScalpMetadata } from './scalpOnlyPolicy.js';

export const V3_MANUAL_EXECUTION_POLICY_VERSION = 'v3-recent-signals-manual-execution-2026-07-17';

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function blocked(reason, extra = {}) {
  return {
    success: false,
    blocked: true,
    reason,
    policyVersion: V3_MANUAL_EXECUTION_POLICY_VERSION,
    ...extra,
  };
}

export function validateRecentQualifiedV3Signal(signal = {}) {
  const stage1 = signal?.qualityConfirmation?.stage1;
  const stage2 = signal?.qualityConfirmation?.stage2;
  const timing = String(signal?.entryTiming?.status || '').toLowerCase();
  const alignment = finite(
    signal?.primaryTimeframeAlignment?.score ??
    signal?.alignment?.timeframeAlignmentScore,
  );
  const score = finite(signal?.v3Score ?? signal?.v3?.score ?? signal?.score);
  const rr = finite(signal?.expectedRR ?? signal?.rr ?? signal?.riskReward);
  const architecture = String(signal?.architecture || signal?.v3?.architecture || '').toLowerCase();

  const reasons = [];
  if (!signal?.pair || typeof signal.pair !== 'string') reasons.push('missing pair');
  if (signal?.direction !== 'long' && signal?.direction !== 'short') reasons.push('missing executable direction');
  if (architecture && architecture !== 'independent_v3_raw_market_data') {
    reasons.push(`unsupported architecture ${architecture}`);
  }
  if (signal?.legacyScannerUsed === true || signal?.legacyConfirmationsUsed === true) {
    reasons.push('legacy scanner or confirmation data is not executable');
  }
  if (stage1?.allowed !== true) reasons.push('native V3 Stage 1 did not pass');
  if (stage2?.allowed !== true) reasons.push('native V3 Stage 2 did not pass');
  if (timing !== 'valid_entry') reasons.push(`entry timing is ${timing || 'missing'}, not valid_entry`);
  if (alignment === null || alignment < 67) reasons.push(`alignment ${alignment ?? 'missing'} < 67`);
  if (score === null || score < 62) reasons.push(`V3 score ${score ?? 'missing'} < 62`);
  if (rr === null || rr < 1.5) reasons.push(`R:R ${rr ?? 'missing'} < 1.5`);

  return {
    allowed: reasons.length === 0,
    reasons,
    metrics: { alignment, score, rr, timing },
    policyVersion: V3_MANUAL_EXECUTION_POLICY_VERSION,
  };
}

export async function executeRecentQualifiedV3Signal({
  signal,
  client,
  now = new Date(),
  log = () => {},
  refreshCandidate = refreshIndependentV3CandidateForExecution,
  execute = executeTrade,
} = {}) {
  if (!client) return blocked('Manual V3 execution requires a user-scoped OANDA client');

  const initial = validateRecentQualifiedV3Signal(signal);
  if (!initial.allowed) {
    return blocked(`Recent signal is no longer executable: ${initial.reasons.join('; ')}`, {
      validation: initial,
      refreshPerformed: false,
    });
  }

  const refreshed = await refreshCandidate({ candidate: signal, client, now, log });
  if (!refreshed?.allowed || !refreshed?.candidate) {
    return blocked(`Fresh V3 Stage 1/Stage 2 validation failed: ${refreshed?.reason || 'candidate no longer qualified'}`, {
      validation: initial,
      refreshPerformed: true,
    });
  }

  const freshSignal = applyScalpMetadata({
    ...signal,
    ...refreshed.candidate,
    source: 'v3_recent_signals_manual',
    strategy: 'V3',
    engine: 'v3',
    tradeStyle: 'SCALP',
    scalpOnly: true,
    selectedLogicType: 'v3_pure',
    architecture: 'independent_v3_raw_market_data',
    legacyScannerUsed: false,
    legacyConfirmationsUsed: false,
    manualExecutionRequested: true,
    manualExecutionPolicyVersion: V3_MANUAL_EXECUTION_POLICY_VERSION,
    environment: client.environment,
  });

  const freshValidation = validateRecentQualifiedV3Signal(freshSignal);
  if (!freshValidation.allowed) {
    return blocked(`Fresh V3 candidate failed manual execution validation: ${freshValidation.reasons.join('; ')}`, {
      validation: freshValidation,
      refreshPerformed: true,
    });
  }

  const result = await execute(freshSignal, { client, autoAi: false });
  return {
    ...result,
    policyVersion: V3_MANUAL_EXECUTION_POLICY_VERSION,
    refreshPerformed: true,
    refreshedPair: freshSignal.pair,
    refreshedDirection: freshSignal.direction,
    refreshedEntry: freshSignal.entry ?? freshSignal.entryPrice ?? null,
    refreshedStopLoss: freshSignal.stopLoss ?? null,
    refreshedTakeProfit: freshSignal.takeProfit ?? null,
    refreshedRR: freshSignal.expectedRR ?? freshSignal.rr ?? freshSignal.riskReward ?? null,
  };
}
