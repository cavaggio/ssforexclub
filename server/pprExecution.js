import { analyzePprPair, pprConfig } from './pprEngine.js';
import { evaluatePprExecutionPolicy } from './pprExecutionPolicy.js';
import { executeTrade } from './oandaTrade.js';
import { pprRuntimeConfig } from './pprEnv.js';
import { applyCombinedLearningCalibration } from './engineTradeLearning.js';
import { getForexNewsRisk } from './oandaNewsRisk.js';

/**
 * PPR owns its final refresh and confirmation. The shared OANDA executor is used
 * only as the broker/risk transport after it recognizes the signal as PPR and
 * skips all legacy/V3/ICT strategy gates.
 */
export async function refreshPprCandidateForExecution({ candidate, client, now = new Date(), log = () => {} } = {}) {
  const runtime = pprRuntimeConfig();
  if (!runtime.engineActive) {
    return { allowed: false, reason: `PPR engine is not active (PPR_ENGINE_MODE=${runtime.engineMode})`, runtime };
  }
  if (!runtime.aiAutoExecutionEnabled) {
    return { allowed: false, reason: 'PPR AI execution is disabled (PPR_AI_AUTO_EXECUTION_ENABLED=false)', runtime };
  }
  if (!candidate?.pair) return { allowed: false, reason: 'PPR candidate pair is missing', runtime };
  const originalDirection = candidate.direction;
  const fresh = await analyzePprPair({ pair: candidate.pair, client, now });
  if (fresh.status !== 'qualified' || !fresh.signal) {
    return { allowed: false, reason: `Fresh PPR confirmation failed: ${fresh.reason || fresh.status || 'unknown'}`, fresh, runtime };
  }
  const calibratedSignal = await applyCombinedLearningCalibration(fresh.signal, { client, engine: 'ppr' });
  if (calibratedSignal.direction !== originalDirection) {
    return { allowed: false, reason: `PPR direction changed from ${originalDirection} to ${calibratedSignal.direction}`, fresh, runtime };
  }

  // Forex Factory RED/HIGH news is a hard execution veto. Re-check after the
  // fresh PPR analysis so a scheduled release cannot be missed by stale scan data.
  const newsRisk = await getForexNewsRisk(candidate.pair, now);
  if (newsRisk?.blocked) {
    return {
      allowed: false,
      reason: newsRisk.reason || 'Forex Factory red/high-impact news blackout active',
      newsRisk,
      fresh,
      calibratedSignal,
      runtime,
    };
  }

  const config = pprConfig();
  if (!(Number(calibratedSignal.confidence) >= config.minConfidence)) {
    return {
      allowed: false,
      reason: `PPR confidence below threshold after combined market/engine calibration (${calibratedSignal.confidence} < ${config.minConfidence})`,
      fresh,
      calibratedSignal,
      runtime,
    };
  }
  const policy = evaluatePprExecutionPolicy(calibratedSignal, {
    minRR: config.minRR,
    maxEntryDistancePips: config.maxEntryDistancePips,
  });
  if (!policy.allowed) {
    return { allowed: false, reason: `PPR policy rejected: ${policy.reasons.join('; ')}`, fresh, policy, runtime };
  }
  log(
    `fresh confirmation pair=${candidate.pair} direction=${originalDirection} ` +
    `manipulations=${policy.manipulationTypes.join('+')} distance=${policy.distancePips}p rr=${policy.rr} ` +
    `engineMode=${runtime.engineMode} autoExecution=${runtime.aiAutoExecutionEnabled} autoManage=${runtime.aiAutoManageEnabled}`,
  );
  return { allowed: true, signal: calibratedSignal, policy, runtime, newsRisk };
}

export async function executePprTrade(candidate, {
  client,
  now = new Date(),
  log = () => {},
  targetRiskUSD = null,
  manualExecution = false,
} = {}) {
  const refreshed = await refreshPprCandidateForExecution({ candidate, client, now, log });
  if (!refreshed.allowed) return { success: false, blocked: true, reason: refreshed.reason, pprRefresh: refreshed };

  const authoritativeTargetRiskUSD = Number(targetRiskUSD ?? candidate?.targetRiskUSD);
  if (manualExecution && (!Number.isFinite(authoritativeTargetRiskUSD) || authoritativeTargetRiskUSD <= 0)) {
    return {
      success: false,
      blocked: true,
      reason: 'PPR manual execution failed: the server could not derive targetRiskUSD from the active account balance.',
      pprRefresh: refreshed,
    };
  }

  const signal = {
    ...refreshed.signal,
    engine: 'ppr',
    strategy: 'PPR',
    source: 'ppr_auto_ai',
    selectedLogicType: 'ppr_native',
    architecture: 'independent_ppr_raw_market_data',
    legacyScannerUsed: false,
    v3LogicUsed: false,
    ictLogicUsed: false,
    environment: client?.environment || refreshed.signal.environment,
    pprRuntime: refreshed.runtime,
    ...(Number.isFinite(authoritativeTargetRiskUSD) && authoritativeTargetRiskUSD > 0
      ? { targetRiskUSD: authoritativeTargetRiskUSD, riskPercent: 1 }
      : {}),
  };
  const result = await executeTrade(signal, {
    client,
    autoAi: true,
    targetRiskUSD: Number.isFinite(authoritativeTargetRiskUSD) ? authoritativeTargetRiskUSD : null,
    manualExecution,
  });
  return {
    ...result,
    engine: 'ppr',
    strategy: 'PPR',
    pprPolicy: refreshed.policy,
    pprRuntime: refreshed.runtime,
    signal,
  };
}
