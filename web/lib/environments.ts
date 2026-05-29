/**
 * web/lib/environments.ts
 *
 * Trading-environment helpers for the settings page. The "Trading environments"
 * panel MUST reflect what the scanner will actually use — anything else is a
 * lie that will confuse the user when their scans don't behave as displayed.
 *
 * The single source of truth is `resolveActiveBrokerForUser` (brokerResolver).
 * This helper takes the resolver's output and projects it into a summary the
 * panel can render, with explicit gate diagnostics (live linked? live
 * acknowledged? platform flag on? user-selected live?).
 *
 * 2026-05-29: refactored to consume the resolved broker. Previously this file
 * ran a parallel calculation that ignored user_trading_settings and used a
 * stale env-flag name, which caused the panel to disagree with the scanner.
 */

import 'server-only';
import type { BrokerConnection, BrokerEnvironment } from './brokerConnections';
import type { ClientSafeBrokerStatus } from './brokerResolver';

export type EnvironmentSummary = {
  paperTradingAvailable: boolean;
  /** True only when the scanner will actually execute live trades for this user. */
  liveTradingEnabled: boolean;
  /** Whatever the resolver says — same value the scanner will use. */
  activeEnvironment: BrokerEnvironment;
  /** Platform kill switch. Mirrors the resolver's view (PLATFORM_LIVE_TRADING_ENABLED with FOREX_ALLOW_LIVE_EXECUTION as back-compat). */
  liveExecutionAllowedByPlatform: boolean;
  /** True when the user has at least one active live broker connection on file. */
  liveConnectionLinked: boolean;
  /** True when the user has accepted the live-trading risk acknowledgement. */
  liveTradingAcknowledged: boolean;
  /** True when the user has flipped the toggle to live. */
  userSelectedLive: boolean;
  /** Human-readable explanation of the gate state — same string the resolver returns. */
  resolverReason: string;
  /** Resolver's machine-readable status (ready / no_credentials / live_not_acknowledged / live_blocked_by_platform / …). */
  brokerCredentialStatus: ClientSafeBrokerStatus['brokerCredentialStatus'];
  perConnection: Array<{
    broker: BrokerConnection['broker'];
    accountId: string;
    environment: BrokerEnvironment;
    isActive: boolean;
  }>;
};

export function summarizeEnvironments(
  connections: BrokerConnection[],
  resolved: ClientSafeBrokerStatus,
): EnvironmentSummary {
  const liveConnectionLinked = connections.some(
    (c) => c.isActive && c.environment === 'live',
  );

  // Live is "enabled" only when the resolver would actually run live trades.
  // That requires: platform flag, user-acknowledged, user-selected live,
  // and a matching live credential row — all checked by the resolver.
  const liveTradingEnabled =
    resolved.isLiveTrading && resolved.brokerCredentialStatus === 'ready';

  return {
    paperTradingAvailable: true,
    liveTradingEnabled,
    activeEnvironment: resolved.activeEnvironment,
    liveExecutionAllowedByPlatform: resolved.platformLiveTradingEnabled,
    liveConnectionLinked,
    liveTradingAcknowledged: resolved.liveTradingAcknowledged,
    userSelectedLive: resolved.activeEnvironment === 'live',
    resolverReason: resolved.reason,
    brokerCredentialStatus: resolved.brokerCredentialStatus,
    perConnection: connections.map((c) => ({
      broker: c.broker,
      accountId: c.accountId,
      environment: c.environment,
      isActive: c.isActive,
    })),
  };
}
