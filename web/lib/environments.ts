/**
 * web/lib/environments.ts
 *
 * Trading-environment helpers. Used by the dashboard to show whether paper /
 * practice / live is currently available without exposing any broker
 * credential.
 *
 * Defaulting policy (Part 5 of the 2026-05-27 spec):
 *   - Paper trading is ALWAYS available (uses OANDA practice / Alpaca paper).
 *   - Live trading is enabled only when:
 *       1. the user has an active broker_connection with environment='live'
 *       2. AND the platform-level FOREX_ALLOW_LIVE_EXECUTION env is 'true'
 *   - Missing / unknown environment on a connection row resolves to 'paper'
 *     so we NEVER silently route to live.
 */

import 'server-only';
import type { BrokerConnection, BrokerEnvironment } from './brokerConnections';

export type EnvironmentSummary = {
  paperTradingAvailable: boolean;
  liveTradingEnabled: boolean;
  activeEnvironment: BrokerEnvironment;
  liveExecutionAllowedByPlatform: boolean;
  perConnection: Array<{
    broker: BrokerConnection['broker'];
    accountId: string;
    environment: BrokerEnvironment;
    isActive: boolean;
  }>;
};

function platformAllowsLiveExecution(): boolean {
  return String(process.env.FOREX_ALLOW_LIVE_EXECUTION || 'false').toLowerCase() === 'true';
}

/**
 * Pick the active environment from a user's connections. Priority:
 *   1. an active LIVE connection (only if platform allows live)
 *   2. an active PAPER connection (Alpaca)
 *   3. an active PRACTICE connection (OANDA)
 *   4. fallback 'paper'
 */
function pickActiveEnvironment(
  connections: BrokerConnection[],
  liveAllowed: boolean
): BrokerEnvironment {
  if (liveAllowed) {
    const live = connections.find((c) => c.isActive && c.environment === 'live');
    if (live) return 'live';
  }
  const paper = connections.find((c) => c.isActive && c.environment === 'paper');
  if (paper) return 'paper';
  const practice = connections.find((c) => c.isActive && c.environment === 'practice');
  if (practice) return 'practice';
  return 'paper';
}

export function summarizeEnvironments(connections: BrokerConnection[]): EnvironmentSummary {
  const liveExecutionAllowedByPlatform = platformAllowsLiveExecution();
  const liveTradingEnabled =
    liveExecutionAllowedByPlatform &&
    connections.some((c) => c.isActive && c.environment === 'live');

  return {
    paperTradingAvailable: true,
    liveTradingEnabled,
    activeEnvironment: pickActiveEnvironment(connections, liveExecutionAllowedByPlatform),
    liveExecutionAllowedByPlatform,
    perConnection: connections.map((c) => ({
      broker: c.broker,
      accountId: c.accountId,
      environment: c.environment,
      isActive: c.isActive,
    })),
  };
}
