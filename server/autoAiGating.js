/**
 * server/autoAiGating.js
 *
 * Pure decision helpers for "is this user/session allowed to execute, and is it
 * a paper or a live order?" — shared, testable logic that mirrors the gates
 * enforced by the broker resolver, the cron route, and the manual-trade routes.
 *
 * Core policy (2026-06-09 paper-enablement):
 *   - practice / paper: execution is allowed with ready creds. It NEVER requires
 *     PLATFORM_LIVE_TRADING_ENABLED and NEVER requires the live-trading
 *     acknowledgement.
 *   - live: still requires BOTH the platform flag AND the live-trading
 *     acknowledgement (unchanged), on top of ready creds.
 *
 * These functions only decide eligibility. The duplicate-lock, sizing, margin,
 * risk caps, and engine-specific signal gates are enforced separately downstream.
 */

const PAPER_ENVS = new Set(['practice', 'paper']);

function normEnv(environment) {
  return String(environment || '').toLowerCase().trim();
}

/**
 * Decide whether an Auto AI tick may run for a user.
 *
 * @param {object} args
 * @param {string} args.activeEnvironment           'practice' | 'paper' | 'live'
 * @param {string} args.brokerCredentialStatus      resolver status ('ready' = creds usable)
 * @param {boolean} args.platformLiveTradingEnabled  PLATFORM_LIVE_TRADING_ENABLED
 * @param {boolean} args.liveTradingAcknowledged     per-user live-ack
 * @returns {{ allowed: boolean, mode?: 'paper'|'live', environment?: string, reason?: string }}
 */
export function autoAiExecutionEligibility({
  activeEnvironment,
  brokerCredentialStatus,
  platformLiveTradingEnabled,
  liveTradingAcknowledged,
} = {}) {
  const env = normEnv(activeEnvironment);
  if (brokerCredentialStatus !== 'ready') {
    return { allowed: false, reason: `broker_${brokerCredentialStatus || 'not_ready'}` };
  }
  if (PAPER_ENVS.has(env)) {
    // Paper/practice: no platform flag, no live-ack required.
    return { allowed: true, mode: 'paper', environment: env };
  }
  if (env === 'live') {
    if (!platformLiveTradingEnabled) return { allowed: false, reason: 'platform_live_trading_disabled' };
    if (!liveTradingAcknowledged) return { allowed: false, reason: 'live_not_acknowledged' };
    return { allowed: true, mode: 'live', environment: 'live' };
  }
  return { allowed: false, reason: 'unknown_environment' };
}

/**
 * Decide whether the manual execution button should be offered for the current
 * session, and what it should say. Paper/practice uses the same paper-friendly
 * policy as Auto AI; live still requires the platform flag + live-ack.
 *
 * @returns {{ allowed: boolean, mode?: 'paper'|'live', label?: string, reason?: string }}
 */
export function manualExecutionEligibility({
  activeEnvironment,
  brokerCredentialStatus,
  platformLiveTradingEnabled,
  liveTradingAcknowledged,
} = {}) {
  const elig = autoAiExecutionEligibility({
    activeEnvironment,
    brokerCredentialStatus,
    platformLiveTradingEnabled,
    liveTradingAcknowledged,
  });
  if (!elig.allowed) return elig;
  return {
    allowed: true,
    mode: elig.mode,
    label: elig.mode === 'paper' ? 'Execute Paper Trade' : 'Execute Live Trade',
  };
}

/** Environments accepted by the internal execution endpoints. */
export function isExecutableEnvironment(environment) {
  const env = normEnv(environment);
  return env === 'live' || PAPER_ENVS.has(env);
}
