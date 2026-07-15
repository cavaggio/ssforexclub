/**
 * web/lib/futuresProvider.ts
 *
 * Server-only credential + feature-flag layer for NinjaTrader, Topstep, and
 * the FTMO MT5 bridge. These reuse broker_connections + AES-256-GCM encryption,
 * but carry a multi-field credential object rather than a single token.
 * Credentials are never returned to the browser.
 */

import 'server-only';
import {
  createBrokerConnection,
  listBrokerConnectionsForUser,
  getDecryptedBrokerCredentials,
  type BrokerConnection,
  type BrokerEnvironment,
} from './brokerConnections';

export type FuturesProvider = 'ninjatrader' | 'topstep' | 'ftmo';

export const NINJATRADER_REQUIRED_FIELDS = ['name', 'password', 'appId', 'appVersion', 'cid', 'sec'] as const;
export const TOPSTEP_REQUIRED_FIELDS = ['userName', 'apiKey'] as const;
export const FTMO_REQUIRED_FIELDS = ['accountLogin', 'server', 'bridgeUrl', 'bridgeApiKey', 'bridgeSecret'] as const;

export type FuturesValidation = { ok: boolean; missing: string[]; error?: string };

const truthy = (v: string | undefined) => String(v || 'false').toLowerCase() === 'true';

export function ninjatraderEnabled(): boolean { return truthy(process.env.NINJATRADER_FUTURES_ENABLED); }
export function ninjatraderLiveEnabled(): boolean { return truthy(process.env.NINJATRADER_LIVE_EXECUTION_ENABLED); }
export function topstepEnabled(): boolean { return truthy(process.env.TOPSTEP_ENABLED); }
export function topstepLiveEnabled(): boolean { return truthy(process.env.TOPSTEP_LIVE_EXECUTION_ENABLED); }
export function topstepCloudExecutionAllowed(): boolean { return truthy(process.env.TOPSTEP_CLOUD_EXECUTION_ALLOWED); }

export const TOPSTEP_COMPLIANCE_MESSAGE =
  'Topstep execution is only enabled when your account, API permissions, and Topstep ' +
  'automation rules allow it.';

function validateFields(creds: Record<string, unknown>, required: readonly string[]): FuturesValidation {
  if (!creds || typeof creds !== 'object') {
    return { ok: false, missing: [...required], error: 'Credentials are required' };
  }
  const missing = required.filter((f) => {
    const v = creds[f];
    return v == null || String(v).trim() === '';
  });
  if (missing.length > 0) return { ok: false, missing, error: `Missing required field(s): ${missing.join(', ')}` };
  return { ok: true, missing: [] };
}

export function validateFuturesCredentials(provider: FuturesProvider, creds: Record<string, unknown>): FuturesValidation {
  if (provider === 'ninjatrader') return validateFields(creds, NINJATRADER_REQUIRED_FIELDS);
  if (provider === 'topstep') return validateFields(creds, TOPSTEP_REQUIRED_FIELDS);

  const result = validateFields(creds, FTMO_REQUIRED_FIELDS);
  if (!result.ok) return result;
  if (!/^\d+$/.test(String(creds.accountLogin).trim())) {
    return { ok: false, missing: [], error: 'FTMO MT5 login must contain digits only' };
  }
  if (String(creds.bridgeSecret).trim().length < 16) {
    return { ok: false, missing: [], error: 'FTMO bridge secret must be at least 16 characters' };
  }
  return { ok: true, missing: [] };
}

function deriveAccountId(provider: FuturesProvider, creds: Record<string, unknown>): string {
  if (provider === 'ninjatrader') return String(creds.name || '').trim();
  if (provider === 'topstep') return String(creds.userName || '').trim();
  return String(creds.accountLogin || '').trim();
}

const VALID_ENVS: Record<FuturesProvider, BrokerEnvironment[]> = {
  ninjatrader: ['paper', 'live'],
  topstep: ['evaluation', 'funded'],
  ftmo: ['challenge', 'verification', 'funded'],
};

export async function saveFuturesConnection(args: {
  clerkUserId: string;
  provider: FuturesProvider;
  environment: BrokerEnvironment;
  credentials: Record<string, unknown>;
}): Promise<BrokerConnection> {
  const { clerkUserId, provider, environment, credentials } = args;
  if (!clerkUserId) throw new Error('saveFuturesConnection: missing clerkUserId');
  if (!VALID_ENVS[provider]?.includes(environment)) {
    throw new Error(`${provider} does not support environment="${environment}"`);
  }
  const check = validateFuturesCredentials(provider, credentials);
  if (!check.ok) throw new Error(check.error);

  const accountId = deriveAccountId(provider, credentials) || provider;
  // createBrokerConnection performs an atomic upsert for this exact logical
  // account, reactivating a previously disabled row without a duplicate insert.
  return createBrokerConnection({
    clerkUserId,
    broker: provider,
    accountId,
    environment,
    token: JSON.stringify(credentials),
    secret: null,
  });
}

export async function listFuturesConnections(
  clerkUserId: string,
  provider: FuturesProvider,
): Promise<BrokerConnection[]> {
  const all = await listBrokerConnectionsForUser(clerkUserId);
  return all.filter((c) => c.broker === provider && c.isActive);
}

export async function resolveFuturesCredentials(
  clerkUserId: string,
  connectionId: string,
): Promise<{ provider: FuturesProvider; environment: BrokerEnvironment; accountId: string; credentials: Record<string, unknown> } | null> {
  const creds = await getDecryptedBrokerCredentials(clerkUserId, connectionId);
  if (!creds) return null;
  if (creds.broker !== 'ninjatrader' && creds.broker !== 'topstep' && creds.broker !== 'ftmo') return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(creds.token);
  } catch {
    throw new Error('resolveFuturesCredentials: stored credential blob is not valid JSON');
  }
  return {
    provider: creds.broker,
    environment: creds.environment,
    accountId: creds.accountId,
    credentials: parsed,
  };
}
