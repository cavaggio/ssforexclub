/**
 * Server-only active broker resolver.
 * FTMO is treated as an MT5-EA execution transport, not an HTTP broker API.
 * Selecting FTMO therefore never falls through to the OANDA execution URL.
 */

import 'server-only';
import { getServerSupabase } from './db';
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
  | 'ready'
  | 'no_settings_yet'
  | 'no_credentials'
  | 'terminal_not_connected'
  | 'live_not_acknowledged'
  | 'live_blocked_by_platform'
  | 'platform_disabled'
  | 'error';

export type ResolvedBroker = {
  activeBroker: ActiveBroker | null;
  activeEnvironment: ActiveEnvironment;
  activeConnectionId: string | null;
  isLiveTrading: boolean;
  isPaperTrading: boolean;
  liveTradingAcknowledged: boolean;
  environmentSource: 'user_setting' | 'fallback_dev_env';
  platformLiveTradingEnabled: boolean;
  brokerCredentialStatus: BrokerResolutionStatus;
  baseUrl: string | null;
  executionTransport?: 'http' | 'mt5_ea' | null;
  getCredentials?: () => Promise<{ token: string; secret: string | null; accountId: string } | null>;
  reason: string;
};

function platformLiveEnabled(): boolean {
  if (process.env.PLATFORM_LIVE_TRADING_ENABLED != null) {
    return String(process.env.PLATFORM_LIVE_TRADING_ENABLED).toLowerCase() === 'true';
  }
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
      (c) => c.id === preferConnectionId && c.broker === broker && c.environment === environment && c.isActive,
    );
    if (match) return match;
  }
  return connections.find((c) => c.broker === broker && c.environment === environment && c.isActive) ?? null;
}

async function connectedFtmoTerminal(userId: string, accountLogin: string): Promise<boolean> {
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('mt5_ea_terminals')
    .select('status,last_heartbeat_at')
    .eq('user_id', userId)
    .eq('account_login', accountLogin)
    .eq('status', 'connected')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data?.last_heartbeat_at) return false;
  const heartbeatMs = new Date(String(data.last_heartbeat_at)).getTime();
  return Number.isFinite(heartbeatMs) && Date.now() - heartbeatMs <= 120_000;
}

function isExecutionRiskMode(broker: ActiveBroker, environment: ActiveEnvironment): boolean {
  return environment === 'live' || broker === 'ftmo';
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
      executionTransport: null,
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

  if (!broker) {
    return {
      activeBroker: null,
      activeEnvironment: env,
      activeConnectionId: null,
      isLiveTrading: false,
      isPaperTrading: true,
      liveTradingAcknowledged: settings.liveTradingAcknowledged,
      environmentSource: 'user_setting',
      platformLiveTradingEnabled: platformLive,
      brokerCredentialStatus: 'no_settings_yet',
      baseUrl: null,
      executionTransport: null,
      reason: 'No broker selected — connect a broker account to enable trading',
    };
  }

  if (env === 'live') {
    if (!platformLive) {
      return baseResolution(settings, broker, null, 'live_blocked_by_platform',
        'Live trading blocked by platform kill switch (PLATFORM_LIVE_TRADING_ENABLED=false)');
    }
    if (!settings.liveTradingAcknowledged) {
      return baseResolution(settings, broker, null, 'live_not_acknowledged',
        'Live mode selected but the trading-risk acknowledgement has not been accepted');
    }
  }

  if (broker === 'ftmo' && !settings.liveTradingAcknowledged) {
    return baseResolution(settings, broker, null, 'live_not_acknowledged',
      'FTMO prop execution requires the trading-risk acknowledgement');
  }

  const conn = pickConnection(connections, broker, env, settings.activeBrokerConnectionId);
  if (!conn) {
    return baseResolution(settings, broker, null, 'no_credentials',
      `${env} mode selected but no active ${broker.toUpperCase()} connection is saved`);
  }

  if (broker === 'ftmo' && !(await connectedFtmoTerminal(clerkUserId, conn.accountId))) {
    return baseResolution(settings, broker, conn.id, 'terminal_not_connected',
      'FTMO connection is saved, but the MT5 EA heartbeat is stale or disconnected');
  }

  const isFundedFtmo = broker === 'ftmo' && env === 'funded';
  const isLive = env === 'live' || isFundedFtmo;

  return {
    activeBroker: broker,
    activeEnvironment: env,
    activeConnectionId: conn.id,
    isLiveTrading: isLive,
    isPaperTrading: !isLive,
    liveTradingAcknowledged: settings.liveTradingAcknowledged,
    environmentSource: 'user_setting',
    platformLiveTradingEnabled: platformLive,
    brokerCredentialStatus: 'ready',
    // FTMO does not expose a direct HTTP execution URL. A null baseUrl is
    // deliberate: legacy OANDA scanner proxies must not accidentally execute
    // against FTMO. The dedicated MT5 queue router handles FTMO commands.
    baseUrl: broker === 'ftmo' ? null : resolveBrokerBaseUrl(broker, env),
    executionTransport: broker === 'ftmo' ? 'mt5_ea' : 'http',
    reason: broker === 'ftmo'
      ? `Active mode: FTMO ${env} via connected MT5 EA`
      : `Active mode: ${broker.toUpperCase()} ${env}`,
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
  const isLive = settings.activeEnvironment === 'live' || (broker === 'ftmo' && settings.activeEnvironment === 'funded');
  return {
    activeBroker: broker,
    activeEnvironment: settings.activeEnvironment,
    activeConnectionId: connectionId,
    isLiveTrading: isLive,
    isPaperTrading: !isLive,
    liveTradingAcknowledged: settings.liveTradingAcknowledged,
    environmentSource: 'user_setting',
    platformLiveTradingEnabled: platformLiveEnabled(),
    brokerCredentialStatus: status,
    baseUrl: null,
    executionTransport: broker === 'ftmo' ? 'mt5_ea' : null,
    reason,
  };
}

export type ClientSafeBrokerStatus = Omit<ResolvedBroker, 'getCredentials'>;

export function toClientSafeBrokerStatus(r: ResolvedBroker): ClientSafeBrokerStatus {
  const { getCredentials: _stripped, ...clientSafe } = r;
  void _stripped;
  return clientSafe;
}

export { isExecutionRiskMode };
