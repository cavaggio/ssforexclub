/**
 * web/lib/futuresProvider.ts
 *
 * Server-only credential + feature-flag layer for IBKR futures, Topstep, and
 * the FTMO MT5 bridge. The legacy canonical value `ninjatrader` is retained for
 * the primary futures slot so existing database constraints and routes remain
 * backward-compatible while the user-facing provider is now IBKR.
 */

import 'server-only';
import {
  createBrokerConnection,
  deactivateBrokerConnection,
  listBrokerConnectionsForUser,
  getDecryptedBrokerCredentials,
  type BrokerConnection,
  type BrokerEnvironment,
} from './brokerConnections';

export type FuturesProvider = 'ninjatrader' | 'topstep' | 'ftmo';

// IBKR individual accounts authenticate through Client Portal Gateway / IB
// Gateway. There is no normal static IBKR API key. The bridge token is optional
// and belongs to a user-operated secure relay, not to IBKR.
export const NINJATRADER_REQUIRED_FIELDS = ['accountId', 'gatewayUrl', 'clientId'] as const;
export const TOPSTEP_REQUIRED_FIELDS = ['userName', 'apiKey'] as const;
export const FTMO_REQUIRED_FIELDS = ['accountLogin', 'server', 'bridgeUrl', 'bridgeApiKey', 'bridgeSecret'] as const;

export type FuturesValidation = { ok: boolean; missing: string[]; error?: string };

const truthy = (v: string | undefined) => String(v || 'false').toLowerCase() === 'true';

export function ninjatraderEnabled(): boolean {
  return truthy(process.env.IBKR_FUTURES_ENABLED ?? process.env.NINJATRADER_FUTURES_ENABLED);
}
export function ninjatraderLiveEnabled(): boolean {
  return truthy(process.env.IBKR_LIVE_EXECUTION_ENABLED ?? process.env.NINJATRADER_LIVE_EXECUTION_ENABLED);
}
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
  if (provider === 'ninjatrader') {
    const result = validateFields(creds, NINJATRADER_REQUIRED_FIELDS);
    if (!result.ok) return result;
    const gatewayUrl = String(creds.gatewayUrl || '').trim();
    if (!/^https?:\/\//i.test(gatewayUrl)) {
      return { ok: false, missing: [], error: 'IBKR Gateway / Bridge URL must begin with http:// or https://' };
    }
    const clientId = Number(creds.clientId);
    if (!Number.isInteger(clientId) || clientId < 0 || clientId > 31) {
      return { ok: false, missing: [], error: 'IBKR API client ID must be an integer from 0 through 31' };
    }
    return { ok: true, missing: [] };
  }
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
  if (provider === 'ninjatrader') return String(creds.accountId || '').trim();
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
  const existing = await listBrokerConnectionsForUser(clerkUserId);
  const stale = existing.filter(
    (c) => c.broker === provider && c.environment === environment && c.accountId === accountId && c.isActive,
  );
  for (const s of stale) await deactivateBrokerConnection(clerkUserId, s.id);

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
