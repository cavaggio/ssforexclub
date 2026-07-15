/**
 * web/lib/futuresProvider.ts
 *
 * Server-only credential + feature-flag layer for NinjaTrader, Topstep, and
 * FTMO connector profiles. These reuse broker_connections + AES-256-GCM
 * encryption, but carry a MULTI-FIELD credential object rather than a single
 * token. The whole object is JSON-encoded and stored in `encrypted_token`
 * (which only ever holds ciphertext). `encrypted_secret` stays null.
 *
 * Credentials are NEVER returned to the browser. The connect Server Actions
 * validate + persist; the proxy decrypts server-side and forwards to the
 * matching provider adapter.
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
export type FtmoPlatform = 'ctrader' | 'mt5' | 'mt4';

export const NINJATRADER_REQUIRED_FIELDS = ['name', 'password', 'appId', 'appVersion', 'cid', 'sec'] as const;
export const TOPSTEP_REQUIRED_FIELDS = ['userName', 'apiKey'] as const;
export const FTMO_CTRADER_REQUIRED_FIELDS = ['accountId', 'accessToken', 'refreshToken'] as const;
export const FTMO_METAAPI_REQUIRED_FIELDS = ['accountId', 'server', 'bridgeAccountId', 'bridgeToken'] as const;

export type FuturesValidation = { ok: boolean; missing: string[]; error?: string };

// ─── feature flags (env) ────────────────────────────────────────────────────
const truthy = (v: string | undefined) => String(v || 'false').toLowerCase() === 'true';

export function ninjatraderEnabled(): boolean { return truthy(process.env.NINJATRADER_FUTURES_ENABLED); }
export function ninjatraderLiveEnabled(): boolean { return truthy(process.env.NINJATRADER_LIVE_EXECUTION_ENABLED); }
export function topstepEnabled(): boolean { return truthy(process.env.TOPSTEP_ENABLED); }
export function topstepLiveEnabled(): boolean { return truthy(process.env.TOPSTEP_LIVE_EXECUTION_ENABLED); }
export function topstepCloudExecutionAllowed(): boolean { return truthy(process.env.TOPSTEP_CLOUD_EXECUTION_ALLOWED); }

export const TOPSTEP_COMPLIANCE_MESSAGE =
  'Topstep execution is only enabled when your account, API permissions, and Topstep ' +
  'automation rules allow it.';

// ─── validation (mirrors the server connectors) ─────────────────────────────
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

function validateFtmoCredentials(creds: Record<string, unknown>): FuturesValidation {
  const platform = String(creds.platform || '').trim().toLowerCase() as FtmoPlatform;

  if (!['ctrader', 'mt5', 'mt4'].includes(platform)) {
    return {
      ok: false,
      missing: ['platform'],
      error: 'FTMO platform must be cTrader, MetaTrader 5, or MetaTrader 4',
    };
  }

  return platform === 'ctrader'
    ? validateFields(creds, FTMO_CTRADER_REQUIRED_FIELDS)
    : validateFields(creds, FTMO_METAAPI_REQUIRED_FIELDS);
}

export function validateFuturesCredentials(provider: FuturesProvider, creds: Record<string, unknown>): FuturesValidation {
  if (provider === 'ninjatrader') return validateFields(creds, NINJATRADER_REQUIRED_FIELDS);
  if (provider === 'topstep') return validateFields(creds, TOPSTEP_REQUIRED_FIELDS);
  return validateFtmoCredentials(creds);
}

/** A stable per-connection account label derived from the credential set. */
function deriveAccountId(provider: FuturesProvider, creds: Record<string, unknown>): string {
  if (provider === 'ninjatrader') return String(creds.name || '').trim();
  if (provider === 'topstep') return String(creds.userName || '').trim();
  return String(creds.accountId || '').trim();
}

const VALID_ENVS: Record<FuturesProvider, BrokerEnvironment[]> = {
  ninjatrader: ['paper', 'live'],
  topstep: ['evaluation', 'funded'],
  ftmo: ['challenge', 'verification', 'funded'],
};

/**
 * Validate + encrypt + persist a provider connection. Returns the created
 * connection metadata (no secrets). Deactivates any stale active row for the
 * same (provider, env, account) first — same upsert-by-history pattern as OANDA.
 */
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

  // The full credential object is JSON-encoded into the (encrypted) token field.
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

/**
 * Decrypt the credential object for a provider connection. SERVER-ONLY — the
 * returned object must never cross the wire. Returns null if not found.
 */
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
