import { analyzePprPair, pprConfig } from './pprEngine.js';
import { evaluatePprExecutionPolicy } from './pprExecutionPolicy.js';
import { executeTrade } from './oandaTrade.js';

/**
 * PPR owns its final refresh and confirmation. The shared OANDA executor is used
 * only as the broker/risk transport after it recognizes the signal as PPR and
 * skips all legacy/V3/ICT strategy gates.
 */
export async function refreshPprCandidateForExecution({ candidate, client, now = new Date(), log = () => {} } = {}) {
  if (!candidate?.pair) return { allowed: false, reason: 'PPR candidate pair is missing' };
  const originalDirection = candidate.direction;
  const fresh = await analyzePprPair({ pair: candidate.pair, client, now });
  if (fresh.status !== 'qualified' || !fresh.signal) {
    return { allowed: false, reason: `Fresh PPR confirmation failed: ${fresh.reason || fresh.status || 'unknown'}`, fresh };
  }
  if (fresh.signal.direction !== originalDirection) {
    return { allowed: false, reason: `PPR direction changed from ${originalDirection} to ${fresh.signal.direction}`, fresh };
  }

  const policy = evaluatePprExecutionPolicy(fresh.signal, { minRR: pprConfig().minRR });
  if (!policy.allowed) {
    return { allowed: false, reason: `PPR policy rejected: ${policy.reasons.join('; ')}`, fresh, policy };
  }
  log(`fresh confirmation pair=${candidate.pair} direction=${originalDirection} manipulation=${policy.manipulationType} rr=${policy.rr}`);
  return { allowed: true, signal: fresh.signal, policy };
}

export async function executePprTrade(candidate, { client, now = new Date(), log = () => {} } = {}) {
  const refreshed = await refreshPprCandidateForExecution({ candidate, client, now, log });
  if (!refreshed.allowed) return { success: false, blocked: true, reason: refreshed.reason, pprRefresh: refreshed };

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
  };
  const result = await executeTrade(signal, { client, autoAi: true });
  return { ...result, engine: 'ppr', strategy: 'PPR', pprPolicy: refreshed.policy, signal };
}
