/**
 * web/lib/userTradingSettings.ts
 *
 * Server-only CRUD for user_trading_settings. Every function requires the
 * authenticated Clerk user ID supplied by the server caller.
 */

import 'server-only';
import { getServerSupabase } from './db';

export type ActiveBroker = 'oanda' | 'alpaca' | 'ninjatrader' | 'topstep' | 'ftmo';
export type ActiveEnvironment = 'practice' | 'paper' | 'live' | 'sim' | 'evaluation' | 'funded';
export type AutoAiEngine = 'ict' | 'v3' | 'ppr';

export type UserTradingSettings = {
  userId: string;
  activeBroker: ActiveBroker | null;
  activeEnvironment: ActiveEnvironment;
  activeBrokerConnectionId: string | null;
  liveTradingAcknowledged: boolean;
  liveTradingAcknowledgedAt: string | null;
  autoAiTradingEnabled: boolean;
  /** Exactly one autonomous engine is selected for this user. */
  autoAiEngine: AutoAiEngine;
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

function normalizeAutoAiEngine(value: unknown): AutoAiEngine {
  if (value === 'v3' || value === 'ppr') return value;
  return 'ict';
}

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
    autoAiEngine:             normalizeAutoAiEngine(row.auto_ai_engine),
    createdAt:                (row.created_at as string | null) ?? null,
    updatedAt:                (row.updated_at as string | null) ?? null,
  };
}

const SETTINGS_SELECT = 'active_broker, active_environment, active_broker_connection_id, live_trading_acknowledged, live_trading_acknowledged_at, auto_ai_trading_enabled, auto_ai_engine, created_at, updated_at';

export async function getUserTradingSettings(clerkUserId: string): Promise<UserTradingSettings> {
  if (!clerkUserId) throw new Error('getUserTradingSettings: missing clerkUserId');
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('user_trading_settings')
    .select(SETTINGS_SELECT)
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
      { onConflict: 'user_id' },
    )
    .select(SETTINGS_SELECT)
    .single();
  if (error || !data) throw new Error(`setActiveBroker: ${error?.message ?? 'no row returned'}`);
  return rowToSettings(data, args.clerkUserId);
}

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
      { onConflict: 'user_id' },
    )
    .select(SETTINGS_SELECT)
    .single();
  if (error || !data) throw new Error(`acknowledgeLiveTrading: ${error?.message ?? 'no row returned'}`);
  return rowToSettings(data, clerkUserId);
}

export async function setAutoAiTrading(
  clerkUserId: string,
  enabled: boolean,
  engine?: AutoAiEngine,
): Promise<UserTradingSettings> {
  if (!clerkUserId) throw new Error('setAutoAiTrading: missing clerkUserId');
  const supabase = getServerSupabase();
  const row: Record<string, unknown> = {
    user_id: clerkUserId,
    auto_ai_trading_enabled: Boolean(enabled),
    updated_at: new Date().toISOString(),
  };
  if (engine === 'ict' || engine === 'v3' || engine === 'ppr') row.auto_ai_engine = engine;
  const { data, error } = await supabase
    .from('user_trading_settings')
    .upsert(row, { onConflict: 'user_id' })
    .select(SETTINGS_SELECT)
    .single();
  if (error || !data) throw new Error(`setAutoAiTrading: ${error?.message ?? 'no row returned'}`);
  return rowToSettings(data, clerkUserId);
}

export function platformLiveTradingEnabled(): boolean {
  return String(process.env.PLATFORM_LIVE_TRADING_ENABLED || 'false').toLowerCase() === 'true';
}
