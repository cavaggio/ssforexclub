/**
 * web/lib/brokerResolver.ts
 *
 * The single source of truth for "which broker credentials apply to this
 * user's request, and is the request allowed to proceed?"
 *
 *   resolveActiveBrokerForUser(clerkUserId)  →  ResolvedBroker
 *
 * Decision flow (Parts 6, 7 of the spec):
 *   1. Load user_trading_settings.
 *   2. If active_broker_connection_id is set: load that connection (filtered
 *      by user_id) and verify the connection's broker+environment matches the
 *      user's selection. If mismatched, treat as "no connection for selected
 *      mode" — never silently swap.
 *   3. If active_environment === 'live': require
 *        - PLATFORM_LIVE_TRADING_ENABLED === 'true'
 *        - live_trading_acknowledged === true
 *        - a credentials row for (active_broker, 'live')
 *      Any missing piece → status='live_blocked' with the specific reason.
 *   4. If active_environment is practice/paper: require a credentials row for
 *      that environment. Missing → status='no_credentials'.
 *   5. Otherwise → status='ready' and the resolver returns the base URL and
 *      a function to fetch decrypted credentials.
 *
 * Critical: this resolver NEVER silently downgrades live→practice or
 * upgrades practice→live. If the user selected live and creds are missing,
 * the call fails — that's the whole point.
 *
 * The decrypted-credential function is held server-side and never returned
 * across the wire — it's a callback for a server-only API proxy.
 */

import 'server-only';
import {
  listBrokerConnectionsForUser,
  getDecryptedBrokerCredentials,
  resolveBrokerBaseUrl,
  type BrokerConnection,
  type BrokerEnvironment,
  type BrokerKind,
} from './brokerConnections';
import {
  getUserTradingSettings,
  type ActiveBroker,
  type ActiveEnvironment,
} from './userTradingSettings';

export type BrokerResolutionStatus =
  | 'ready'                     // creds resolved, request can proceed
  | 'no_settings_yet'           // user has never touched the toggle — defaults to practice
  | 'no_credentials'            // selected mode has no matching connection
  | 'live_not_acknowledged'     // selected live but never accepted the risk warning
  | 'live_blocked_by_platform'  // PLATFORM_LIVE_TRADING_ENABLED=false
  | 'platform_disabled'         // catch-all for emergency switch
  | 'error';                    // unexpected resolution failure

export type ResolvedBroker = {
  activeBroker:                ActiveBroker | null;
  activeEnvironment:           ActiveEnvironment;
  activeConnectionId:          string | null;
  isLiveTrading:               boolean;
  isPaperTrading:              boolean;
  liveTradingAcknowledged:     boolean;
  environmentSource:           'user_setting' | 'fallback_dev_env';
  platformLiveTradingEnabled:  boolean;
  brokerCredentialStatus:      BrokerResolutionStatus;
  baseUrl:                     string | null;
  // Server-side only callback — never serialize this.
  // Resolves the decrypted credentials at call time so they live in memory
  // only as long as the upstream API call.
  getCredentials?:             () => Promise<{ token: string; secret: string | null; accountId: string } | null>;
  reason:                      string;
};

function platformLiveEnabled(): boolean {
  // Primary flag (new).
  if (process.env.PLATFORM_LIVE_TRADING_ENABLED != null) {
    return String(process.env.PLATFORM_LIVE_TRADING_ENABLED).toLowerCase() === 'true';
  }
  // Back-compat: the old scanner-side flag — if set to true, treat as platform-on.
  return String(process.env.FOREX_ALLOW_LIVE_EXECUTION || 'false').toLowerCase() === 'true';
}

function pickConnection(
  connections: BrokerConnection[],
  broker: BrokerKind,
  environment: BrokerEnvironment,
  preferConnectionId: string | null,
): BrokerConnection | null {
  if (preferConnectionId) {
    const match = connections.find(
      (c) => c.id === preferConnectionId && c.broker === broker && c.environment === environment && c.isActive
    );
    if (match) return match;
  }
  // Fallback: most recent active connection for the (broker, environment) pair.
  return connections.find((c) => c.broker === broker && c.environment === environment && c.isActive) ?? null;
}

export async function resolveActiveBrokerForUser(clerkUserId: string): Promise<ResolvedBroker> {
  if (!clerkUserId) {
    return {
      activeBroker: null,
      activeEnvironment: 'practice',
      activeConnectionId: null,
      isLiveTrading: false,
      isPaperTrading: true,
      liveTradingAcknowledged: false,
      environmentSource: 'fallback_dev_env',
      platformLiveTradingEnabled: platformLiveEnabled(),
      brokerCredentialStatus: 'error',
      baseUrl: null,
      reason: 'No authenticated user',
    };
  }

  const [settings, connections] = await Promise.all([
    getUserTradingSettings(clerkUserId),
    listBrokerConnectionsForUser(clerkUserId),
  ]);

  const broker = settings.activeBroker;
  const env = settings.activeEnvironment;
  const platformLive = platformLiveEnabled();

  // No selection yet → safe default "practice" but no creds resolved.
  if (!broker) {
    return {
      activeBroker: null,
      activeEnvironment: env,
      activeConnectionId: null,
      isLiveTrading: false,
      isPaperTrading: env !== 'live',
      liveTradingAcknowledged: settings.liveTradingAcknowledged,
      environmentSource: 'user_setting',
      platformLiveTradingEnabled: platformLive,
      brokerCredentialStatus: 'no_settings_yet',
      baseUrl: null,
      reason: 'No broker selected — connect a broker account to enable trading',
    };
  }

  // Live mode — extra gates.
  if (env === 'live') {
    if (!platformLive) {
      return baseResolution(settings, broker, null, 'live_blocked_by_platform',
        'Live trading blocked by platform kill switch (PLATFORM_LIVE_TRADING_ENABLED=false)');
    }
    if (!settings.liveTradingAcknowledged) {
      return baseResolution(settings, broker, null, 'live_not_acknowledged',
        'Live mode selected but the live-trading risk acknowledgement has not been accepted');
    }
  }

  // Pick the active connection.
  const conn = pickConnection(connections, broker, env, settings.activeBrokerConnectionId);
  if (!conn) {
    const friendly = env === 'live'
      ? `Live mode selected but no live ${broker.toUpperCase()} credentials connected`
      : `${env} mode selected but no ${env} ${broker.toUpperCase()} credentials connected`;
    return baseResolution(settings, broker, null, 'no_credentials', friendly);
  }

  // Everything resolved.
  return {
    activeBroker: broker,
    activeEnvironment: env,
    activeConnectionId: conn.id,
    isLiveTrading: env === 'live',
    isPaperTrading: env !== 'live',
    liveTradingAcknowledged: settings.liveTradingAcknowledged,
    environmentSource: 'user_setting',
    platformLiveTradingEnabled: platformLive,
    brokerCredentialStatus: 'ready',
    baseUrl: resolveBrokerBaseUrl(broker, env),
    reason: `Active mode: ${broker.toUpperCase()} ${env}`,
    getCredentials: async () => {
      const creds = await getDecryptedBrokerCredentials(clerkUserId, conn.id);
      if (!creds) return null;
      return { token: creds.token, secret: creds.secret, accountId: creds.accountId };
    },
  };
}

function baseResolution(
  settings: Awaited<ReturnType<typeof getUserTradingSettings>>,
  broker: ActiveBroker,
  connectionId: string | null,
  status: BrokerResolutionStatus,
  reason: string,
): ResolvedBroker {
  return {
    activeBroker: broker,
    activeEnvironment: settings.activeEnvironment,
    activeConnectionId: connectionId,
    isLiveTrading: settings.activeEnvironment === 'live',
    isPaperTrading: settings.activeEnvironment !== 'live',
    liveTradingAcknowledged: settings.liveTradingAcknowledged,
    environmentSource: 'user_setting',
    platformLiveTradingEnabled: platformLiveEnabled(),
    brokerCredentialStatus: status,
    baseUrl: null,
    reason,
  };
}

/**
 * Plain-JSON projection of `ResolvedBroker` — strings, booleans, numbers
 * and arrays only. Crucially, NO function fields (i.e. no `getCredentials`).
 *
 * React will throw at runtime if a Server Component passes a non-serializable
 * value to a Client Component:
 *
 *   Error: Functions cannot be passed directly to Client Components unless
 *   you explicitly expose it by marking it with "use server".
 *
 * Every Server Component that hands broker context down to a `"use client"`
 * component MUST funnel it through `toClientSafeBrokerStatus()` first.
 */
export type ClientSafeBrokerStatus = Omit<ResolvedBroker, 'getCredentials'>;

/**
 * Strip server-only callbacks (currently just `getCredentials`) before
 * serializing the resolved broker for an API response or client-component
 * prop. Destructure-and-rest pattern: if a future field is added that is
 * also non-serializable, add it to the `_stripped` destructure list.
 */
export function toClientSafeBrokerStatus(r: ResolvedBroker): ClientSafeBrokerStatus {
  const { getCredentials: _stripped, ...clientSafe } = r;
  void _stripped;   // referenced solely to satisfy `noUnusedLocals`
  return clientSafe;
}
