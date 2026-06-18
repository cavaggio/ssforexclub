/**
 * web/lib/userTradingSettings.ts
 *
 * Server-only CRUD for user_trading_settings. Every function REQUIRES a
 * clerkUserId supplied by the caller (typically `(await auth()).userId`).
 * Never accept a user_id from the browser.
 *
 * Lifecycle:
 *   - Row is created lazily on first read or write. A user with no row gets
 *     the safe default: `active_environment = 'practice'`,
 *     `live_trading_acknowledged = false`.
 *   - Acknowledgement is one-time and irreversible (the user can always flip
 *     back to practice; the ack just stays true).
 */

import 'server-only';
import { getServerSupabase } from './db';

export type ActiveBroker = 'oanda' | 'alpaca' | 'ninjatrader' | 'topstep';
export type ActiveEnvironment = 'practice' | 'paper' | 'live' | 'sim' | 'evaluation' | 'funded';

export type UserTradingSettings = {
  userId: string;
  activeBroker: ActiveBroker | null;
  activeEnvironment: ActiveEnvironment;
  activeBrokerConnectionId: string | null;
  liveTradingAcknowledged: boolean;
  liveTradingAcknowledgedAt: string | null;
  /** Per-user opt-in for AI auto-trading. Default false. The scheduler reads this. */
  autoAiTradingEnabled: boolean;
  /** Which engine auto-trades for this user — ICT or V3, never both. Default 'ict'. */
  autoAiEngine: 'ict' | 'v3';
  createdAt: string | null;
  updatedAt: string | null;
};

const DEFAULT_SETTINGS: Omit<UserTradingSettings, 'userId'> = {
  activeBroker: null,
  activeEnvironment: 'practice',
  activeBrokerConnectionId: null,
  liveTradingAcknowledged: false,
  liveTradingAcknowledgedAt: null,
  autoAiTradingEnabled: false,
  autoAiEngine: 'ict',
  createdAt: null,
  updatedAt: null,
};

function rowToSettings(row: Record<string, unknown> | null, userId: string): UserTradingSettings {
  if (!row) return { userId, ...DEFAULT_SETTINGS };
  return {
    userId,
    activeBroker:             (row.active_broker as ActiveBroker | null) ?? null,
    activeEnvironment:        (row.active_environment as ActiveEnvironment | null) ?? 'practice',
    activeBrokerConnectionId: (row.active_broker_connection_id as string | null) ?? null,
    liveTradingAcknowledged:  Boolean(row.live_trading_acknowledged),
    liveTradingAcknowledgedAt:(row.live_trading_acknowledged_at as string | null) ?? null,
    autoAiTradingEnabled:     Boolean(row.auto_ai_trading_enabled),
    autoAiEngine:             (row.auto_ai_engine === 'v3' ? 'v3' : 'ict'),
    createdAt:                (row.created_at as string | null) ?? null,
    updatedAt:                (row.updated_at as string | null) ?? null,
  };
}

/**
 * Read the user's settings, returning safe defaults if no row exists yet.
 * This does NOT create a row — writes happen via the action helpers below.
 */
export async function getUserTradingSettings(clerkUserId: string): Promise<UserTradingSettings> {
  if (!clerkUserId) throw new Error('getUserTradingSettings: missing clerkUserId');
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('user_trading_settings')
    .select('active_broker, active_environment, active_broker_connection_id, live_trading_acknowledged, live_trading_acknowledged_at, auto_ai_trading_enabled, auto_ai_engine, created_at, updated_at')
    .eq('user_id', clerkUserId)
    .maybeSingle();
  if (error) throw new Error(`getUserTradingSettings: ${error.message}`);
  return rowToSettings(data, clerkUserId);
}

type SetActiveBrokerArgs = {
  clerkUserId: string;
  activeBroker: ActiveBroker;
  activeEnvironment: ActiveEnvironment;
  activeBrokerConnectionId: string | null;
};

/**
 * Set the active broker + environment + connection. Upserts the row. Callers
 * are responsible for the live-acknowledgement gate (see the Server Action
 * setActiveTradingModeAction).
 */
export async function setActiveBroker(args: SetActiveBrokerArgs): Promise<UserTradingSettings> {
  if (!args.clerkUserId) throw new Error('setActiveBroker: missing clerkUserId');
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('user_trading_settings')
    .upsert(
      {
        user_id: args.clerkUserId,
        active_broker: args.activeBroker,
        active_environment: args.activeEnvironment,
        active_broker_connection_id: args.activeBrokerConnectionId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    )
    .select('active_broker, active_environment, active_broker_connection_id, live_trading_acknowledged, live_trading_acknowledged_at, auto_ai_trading_enabled, auto_ai_engine, created_at, updated_at')
    .single();
  if (error || !data) throw new Error(`setActiveBroker: ${error?.message ?? 'no row returned'}`);
  return rowToSettings(data, args.clerkUserId);
}

/**
 * Record the one-time live-trading acknowledgement. Irreversible from the
 * UI — the user can always flip back to practice but the flag stays true.
 */
export async function acknowledgeLiveTrading(clerkUserId: string): Promise<UserTradingSettings> {
  if (!clerkUserId) throw new Error('acknowledgeLiveTrading: missing clerkUserId');
  const supabase = getServerSupabase();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('user_trading_settings')
    .upsert(
      {
        user_id: clerkUserId,
        live_trading_acknowledged: true,
        live_trading_acknowledged_at: now,
        updated_at: now,
      },
      { onConflict: 'user_id' }
    )
    .select('active_broker, active_environment, active_broker_connection_id, live_trading_acknowledged, live_trading_acknowledged_at, auto_ai_trading_enabled, auto_ai_engine, created_at, updated_at')
    .single();
  if (error || !data) throw new Error(`acknowledgeLiveTrading: ${error?.message ?? 'no row returned'}`);
  return rowToSettings(data, clerkUserId);
}

/**
 * Toggle per-user AI auto-trading. Upserts the row. This is the source of truth
 * for the dashboard "Auto AI Trading" toggle; the platform env flag is a
 * separate upper-level gate enforced at execution time.
 */
export async function setAutoAiTrading(clerkUserId: string, enabled: boolean, engine?: 'ict' | 'v3'): Promise<UserTradingSettings> {
  if (!clerkUserId) throw new Error('setAutoAiTrading: missing clerkUserId');
  const supabase = getServerSupabase();
  const row: Record<string, unknown> = {
    user_id: clerkUserId,
    auto_ai_trading_enabled: Boolean(enabled),
    updated_at: new Date().toISOString(),
  };
  // Single engine field → only one engine can ever be active (mutual exclusivity).
  if (engine === 'ict' || engine === 'v3') row.auto_ai_engine = engine;
  const { data, error } = await supabase
    .from('user_trading_settings')
    .upsert(row, { onConflict: 'user_id' })
    .select('active_broker, active_environment, active_broker_connection_id, live_trading_acknowledged, live_trading_acknowledged_at, auto_ai_trading_enabled, auto_ai_engine, created_at, updated_at')
    .single();
  if (error || !data) throw new Error(`setAutoAiTrading: ${error?.message ?? 'no row returned'}`);
  return rowToSettings(data, clerkUserId);
}

/** Platform-level upper gate for any live auto-trading (env, not per-user). */
export function platformLiveTradingEnabled(): boolean {
  return String(process.env.PLATFORM_LIVE_TRADING_ENABLED || 'false').toLowerCase() === 'true';
}
