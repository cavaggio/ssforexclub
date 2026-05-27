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
 *   - Credentials are encrypted before insert and never returned to callers.
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

export type BrokerKind = 'oanda' | 'alpaca';
export type BrokerEnvironment = 'practice' | 'live' | 'paper';

export type BrokerConnection = {
  id: string;
  userId: string;
  broker: BrokerKind;
  accountId: string;
  environment: BrokerEnvironment;
  isActive: boolean;
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
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function listBrokerConnectionsForUser(
  clerkUserId: string
): Promise<BrokerConnection[]> {
  if (!clerkUserId) throw new Error('listBrokerConnectionsForUser: missing clerkUserId');
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('broker_connections')
    .select('id, user_id, broker, account_id, environment, is_active, created_at, updated_at')
    .eq('user_id', clerkUserId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`listBrokerConnectionsForUser: ${error.message}`);
  return (data ?? []).map(rowToConnection);
}

export async function createBrokerConnection(
  input: CreateInput
): Promise<BrokerConnection> {
  if (!input.clerkUserId) throw new Error('createBrokerConnection: missing clerkUserId');
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('broker_connections')
    .insert({
      user_id: input.clerkUserId,
      broker: input.broker,
      account_id: input.accountId,
      environment: input.environment,
      encrypted_token: encryptSecret(input.token),
      encrypted_secret: input.secret ? encryptSecret(input.secret) : null,
      is_active: true,
    })
    .select('id, user_id, broker, account_id, environment, is_active, created_at, updated_at')
    .single();
  if (error || !data) {
    throw new Error(`createBrokerConnection: ${error?.message ?? 'no row returned'}`);
  }
  return rowToConnection(data);
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
  throw new Error(`Unsupported broker: ${broker}`);
}
