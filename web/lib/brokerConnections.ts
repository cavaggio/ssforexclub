/**
 * web/lib/brokerConnections.ts
 *
 * Server-only CRUD for broker_connections.
 *
 *   - Every function REQUIRES a `clerkUserId` argument supplied by the caller
 *     (typically `auth().userId` from a Server Component or Route Handler).
 *   - Every query filters by `user_id = clerkUserId`. A future bug that
 *     forgets the filter would still hit RLS-disabled service-role land, so
 *     defense-in-depth: code review and tests should pin this contract.
 *   - Credentials are encrypted before insert/update and never returned to callers.
 *     A separate helper `getDecryptedTokenForUser` is provided for the
 *     scanner/proxy code that needs to call broker APIs server-side.
 *
 * What this file deliberately does NOT do:
 *   - accept a user_id from request body / URL params
 *   - return encrypted_token / encrypted_secret to the caller
 *   - expose anything callable from the browser
 */

import 'server-only';
import { getServerSupabase } from './db';
import { decryptSecret, encryptSecret } from './encryption';

export type BrokerKind = 'oanda' | 'alpaca' | 'ninjatrader' | 'topstep' | 'ftmo';
// 'sim' = NinjaTrader simulated; 'evaluation'/'funded' = Topstep combine/funded.
export type BrokerEnvironment = 'practice' | 'live' | 'paper' | 'sim' | 'evaluation' | 'funded' | 'challenge' | 'verification';

// Canonical vocabulary, matching the DB column + the dashboard labels.
export type ValidationStatus = 'pending' | 'validated' | 'failed';

export type BrokerConnection = {
  id: string;
  userId: string;
  broker: BrokerKind;
  accountId: string;
  environment: BrokerEnvironment;
  isActive: boolean;
  validationStatus: ValidationStatus;
  lastValidatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type CreateInput = {
  clerkUserId: string;
  broker: BrokerKind;
  accountId: string;
  environment: BrokerEnvironment;
  token: string;          // plaintext — encrypted before persistence
  secret?: string | null; // optional — Alpaca has both key+secret, OANDA is token-only
};

function rowToConnection(row: Record<string, unknown>): BrokerConnection {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    broker: row.broker as BrokerKind,
    accountId: String(row.account_id),
    environment: row.environment as BrokerEnvironment,
    isActive: Boolean(row.is_active),
    validationStatus: (row.validation_status as ValidationStatus) ?? 'pending',
    lastValidatedAt: (row.last_validated_at as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// Columns added by the futures migration (20260618000000). Production may not
// have them applied yet, so every select tries them first and transparently
// falls back to the base columns if Postgres reports they don't exist. This
// keeps the settings page (and the broker resolver) from crashing on a partial
// migration; rowToConnection defaults the missing fields safely.
const BASE_COLS = 'id, user_id, broker, account_id, environment, is_active, created_at, updated_at';
const FULL_COLS = `${BASE_COLS}, validation_status, last_validated_at`;

function isMissingColumnError(error: { message?: string; code?: string } | null): boolean {
  if (!error) return false;
  // Postgres undefined_column = 42703; PostgREST surfaces it in the message too.
  return error.code === '42703' || /validation_status|last_validated_at|column .* does not exist|schema cache/i.test(error.message || '');
}

export async function listBrokerConnectionsForUser(
  clerkUserId: string
): Promise<BrokerConnection[]> {
  if (!clerkUserId) throw new Error('listBrokerConnectionsForUser: missing clerkUserId');
  const supabase = getServerSupabase();
  const run = (cols: string) =>
    supabase.from('broker_connections').select(cols).eq('user_id', clerkUserId).order('created_at', { ascending: false });

  let { data, error } = await run(FULL_COLS);
  if (error && isMissingColumnError(error)) {
    ({ data, error } = await run(BASE_COLS));
  }
  if (error) throw new Error(`listBrokerConnectionsForUser: ${error.message}`);
  return (data ?? []).map((r) => rowToConnection(r as unknown as Record<string, unknown>));
}

/**
 * Create or refresh one logical broker connection.
 *
 * The database has a unique key on (user_id, broker, account_id, environment),
 * so reconnecting the same account must update that row in place. Using an
 * atomic upsert also prevents the old failure mode where code deactivated a
 * connection first, the replacement insert failed as a duplicate, and the
 * user was left with a disabled account.
 */
export async function createBrokerConnection(
  input: CreateInput
): Promise<BrokerConnection> {
  if (!input.clerkUserId) throw new Error('createBrokerConnection: missing clerkUserId');
  const supabase = getServerSupabase();
  const now = new Date().toISOString();
  const baseRow = {
    user_id: input.clerkUserId,
    broker: input.broker,
    account_id: input.accountId,
    environment: input.environment,
    encrypted_token: encryptSecret(input.token),
    encrypted_secret: input.secret ? encryptSecret(input.secret) : null,
    is_active: true,
    updated_at: now,
  };
  const fullRow = {
    ...baseRow,
    validation_status: 'pending',
    last_validated_at: null,
  };
  const run = (cols: string, row: Record<string, unknown>) =>
    supabase
      .from('broker_connections')
      .upsert(row, { onConflict: 'user_id,broker,account_id,environment' })
      .select(cols)
      .single();

  let { data, error } = await run(FULL_COLS, fullRow);
  if (error && isMissingColumnError(error)) {
    ({ data, error } = await run(BASE_COLS, baseRow));
  }
  if (error || !data) {
    throw new Error(`createBrokerConnection: ${error?.message ?? 'no row returned'}`);
  }
  return rowToConnection(data as unknown as Record<string, unknown>);
}

export type SetValidationResult =
  | { ok: true; rowsUpdated: number }
  | { ok: false; code: 'UPDATE_NO_ROWS' | 'UPDATE_ERROR' | 'BAD_ARGS'; error?: string };

/**
 * Persist a connection's validation outcome. Scoped by BOTH user_id AND id so
 * one user can never update another's row and duplicate broker/env rows never
 * collide. Returns a structured result — the caller surfaces failures rather
 * than silently no-opping. Asserts exactly one row was updated. Never throws;
 * never touches credentials.
 */
export async function setConnectionValidationStatus(
  clerkUserId: string,
  connectionId: string,
  status: 'validated' | 'failed',
): Promise<SetValidationResult> {
  if (!clerkUserId || !connectionId) return { ok: false, code: 'BAD_ARGS' };
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('broker_connections')
    .update({ validation_status: status, last_validated_at: new Date().toISOString() })
    .eq('user_id', clerkUserId)
    .eq('id', connectionId)
    .select('id'); // returns exactly the rows that were updated
  if (error) {
    console.warn(`[VALIDATE_PERSIST] update failed connection=${connectionId} code=${error.code ?? '?'} msg=${error.message}`);
    return { ok: false, code: 'UPDATE_ERROR', error: error.message };
  }
  const rowsUpdated = Array.isArray(data) ? data.length : 0;
  if (rowsUpdated !== 1) {
    console.warn(`[VALIDATE_PERSIST] expected 1 row, updated ${rowsUpdated} for connection=${connectionId}`);
    return { ok: false, code: 'UPDATE_NO_ROWS' };
  }
  return { ok: true, rowsUpdated };
}

export async function deactivateBrokerConnection(
  clerkUserId: string,
  connectionId: string
): Promise<void> {
  if (!clerkUserId) throw new Error('deactivateBrokerConnection: missing clerkUserId');
  const supabase = getServerSupabase();
  const { error } = await supabase
    .from('broker_connections')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('user_id', clerkUserId)
    .eq('id', connectionId);
  if (error) throw new Error(`deactivateBrokerConnection: ${error.message}`);
}

/**
 * Returns the DECRYPTED broker token for the given user + connection. Used by
 * server-side code paths that need to call OANDA / Alpaca on behalf of the
 * user (e.g. an API route that proxies a request).
 *
 * CRITICAL — never expose the returned object to the browser. Functions that
 * call this should immediately use the credentials to make the upstream API
 * call and only return the broker's response (or a sanitized subset of it).
 */
export async function getDecryptedBrokerCredentials(
  clerkUserId: string,
  connectionId: string
): Promise<{
  broker: BrokerKind;
  accountId: string;
  environment: BrokerEnvironment;
  token: string;
  secret: string | null;
} | null> {
  if (!clerkUserId) throw new Error('getDecryptedBrokerCredentials: missing clerkUserId');
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('broker_connections')
    .select('broker, account_id, environment, encrypted_token, encrypted_secret, is_active')
    .eq('user_id', clerkUserId)
    .eq('id', connectionId)
    .single();
  if (error) {
    if (error.code === 'PGRST116') return null; // no row
    throw new Error(`getDecryptedBrokerCredentials: ${error.message}`);
  }
  if (!data || !data.is_active) return null;
  return {
    broker: data.broker as BrokerKind,
    accountId: String(data.account_id),
    environment: data.environment as BrokerEnvironment,
    token: decryptSecret(String(data.encrypted_token)),
    secret: data.encrypted_secret ? decryptSecret(String(data.encrypted_secret)) : null,
  };
}

/**
 * Resolves the broker base URL for a given (broker, environment) pair.
 * Centralized so any new broker / env combination has one place to update.
 */
export function resolveBrokerBaseUrl(
  broker: BrokerKind,
  environment: BrokerEnvironment
): string {
  if (broker === 'oanda') {
    if (environment === 'practice') {
      return process.env.OANDA_PRACTICE_URL || 'https://api-fxpractice.oanda.com';
    }
    if (environment === 'live') {
      return process.env.OANDA_LIVE_URL || 'https://api-fxtrade.oanda.com';
    }
    throw new Error(`OANDA does not support environment="${environment}"`);
  }
  if (broker === 'alpaca') {
    if (environment === 'paper') {
      return process.env.ALPACA_PAPER_URL || 'https://paper-api.alpaca.markets';
    }
    if (environment === 'live') {
      return process.env.ALPACA_LIVE_URL || 'https://api.alpaca.markets';
    }
    throw new Error(`Alpaca does not support environment="${environment}"`);
  }
  if (broker === 'ninjatrader') {
    // Futures connectors resolve their own gateway URL server-side; this is
    // returned only so the broker resolver doesn't throw when NinjaTrader is
    // the active broker. Futures execution does NOT flow through this URL.
    return process.env.NINJATRADER_GATEWAY_URL || 'https://gateway.ninjatrader.com';
  }
  if (broker === 'topstep') {
    return process.env.TOPSTEP_API_BASE_URL || 'https://api.topstepx.com';
  }
  if (broker === 'ftmo') {
    return process.env.FTMO_API_BASE_URL || process.env.FTMO_CTRADER_API_BASE_URL || 'https://api.ctrader.com';
  }
  throw new Error(`Unsupported broker: ${broker}`);
}
