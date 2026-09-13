/**
 * Dashboard server actions for broker selection and connection management.
 * FTMO prop accounts use the outbound MT5 EA bridge and may be selected only
 * after their terminal has completed a valid heartbeat.
 */

'use server';

import { auth, currentUser } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import { getServerSupabase } from '@/lib/db';
import {
  createBrokerConnection,
  deactivateBrokerConnection,
  listBrokerConnectionsForUser,
  type BrokerKind,
  type BrokerEnvironment,
} from '@/lib/brokerConnections';
import {
  setActiveBroker,
  acknowledgeLiveTrading,
  getUserTradingSettings,
  type ActiveBroker,
  type ActiveEnvironment,
} from '@/lib/userTradingSettings';
import { upsertUserFromClerk } from '@/lib/users';

export type ActionResult = { ok: true } | { ok: false; error: string };

const OANDA_ACCOUNT_ID_PATTERN = /^\d{3}-\d{3}-\d{6,12}-\d{3}$/;
const FTMO_ENVIRONMENTS = new Set<ActiveEnvironment>(['challenge', 'verification', 'funded']);

async function requireUserId(): Promise<string> {
  const { userId } = await auth();
  if (!userId) throw new Error('Unauthenticated');
  const u = await currentUser();
  if (u) {
    await upsertUserFromClerk({
      clerkUserId: u.id,
      email: u.primaryEmailAddress?.emailAddress ?? '',
    }).catch(() => undefined);
  }
  return userId;
}

async function ftmoTerminalConnected(userId: string, accountLogin: string): Promise<boolean> {
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
  const heartbeat = new Date(String(data.last_heartbeat_at)).getTime();
  return Number.isFinite(heartbeat) && Date.now() - heartbeat <= 120_000;
}

export async function saveBrokerConnectionAction(formData: FormData): Promise<ActionResult> {
  try {
    const userId = await requireUserId();
    const broker = String(formData.get('broker') || '').toLowerCase() as BrokerKind;
    const environment = String(formData.get('environment') || '').toLowerCase() as BrokerEnvironment;
    const accountId = String(formData.get('accountId') || '').trim();
    const token = String(formData.get('token') || '').trim();
    const secret = String(formData.get('secret') || '').trim() || null;

    if (broker !== 'oanda' && broker !== 'alpaca') {
      return { ok: false, error: 'Use the dedicated FTMO or Futures connection page for non-OANDA/Alpaca brokers' };
    }
    if (!['practice', 'paper', 'live'].includes(environment)) {
      return { ok: false, error: 'Environment must be practice, paper, or live' };
    }
    if (!accountId) return { ok: false, error: 'Account ID is required' };
    if (!token) return { ok: false, error: 'API token is required' };
    if (broker === 'oanda' && !OANDA_ACCOUNT_ID_PATTERN.test(accountId)) {
      return {
        ok: false,
        error: 'Enter your OANDA account ID, not your email address. Example: 101-001-39311050-001.',
      };
    }

    await createBrokerConnection({ clerkUserId: userId, broker, accountId, environment, token, secret });
    revalidatePath('/dashboard');
    revalidatePath('/dashboard/settings');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function setActiveTradingModeAction(formData: FormData): Promise<ActionResult> {
  try {
    const userId = await requireUserId();
    const broker = String(formData.get('broker') || '').toLowerCase() as ActiveBroker;
    const environment = String(formData.get('environment') || '').toLowerCase() as ActiveEnvironment;

    if (broker !== 'oanda' && broker !== 'alpaca' && broker !== 'ftmo') {
      return { ok: false, error: 'Broker must be OANDA, Alpaca, or FTMO' };
    }

    const validEnvironment = broker === 'ftmo'
      ? FTMO_ENVIRONMENTS.has(environment)
      : ['practice', 'paper', 'live'].includes(environment);
    if (!validEnvironment) {
      return {
        ok: false,
        error: broker === 'ftmo'
          ? 'FTMO environment must be challenge, verification, or funded'
          : 'Environment must be practice, paper, or live',
      };
    }

    const settings = await getUserTradingSettings(userId);
    if ((environment === 'live' || broker === 'ftmo') && !settings.liveTradingAcknowledged) {
      return { ok: false, error: 'Accept the trading-risk acknowledgement before activating this execution account' };
    }

    const connections = await listBrokerConnectionsForUser(userId);
    const conn = connections.find((c) => c.broker === broker && c.environment === environment && c.isActive);
    if (!conn) return { ok: false, error: `No active ${environment} ${broker.toUpperCase()} connection is saved` };

    if (broker === 'ftmo' && !(await ftmoTerminalConnected(userId, conn.accountId))) {
      return { ok: false, error: 'FTMO MT5 EA is not currently connected. Restore the heartbeat before selecting FTMO.' };
    }

    await setActiveBroker({
      clerkUserId: userId,
      activeBroker: broker,
      activeEnvironment: environment,
      activeBrokerConnectionId: conn.id,
    });

    revalidatePath('/dashboard');
    revalidatePath('/dashboard/settings');
    revalidatePath('/dashboard/ftmo');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function acknowledgeLiveTradingAction(): Promise<ActionResult> {
  try {
    const userId = await requireUserId();
    await acknowledgeLiveTrading(userId);
    revalidatePath('/dashboard');
    revalidatePath('/dashboard/settings');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function removeBrokerConnectionAction(formData: FormData): Promise<ActionResult> {
  try {
    const userId = await requireUserId();
    const connectionId = String(formData.get('connectionId') || '').trim();
    if (!connectionId) return { ok: false, error: 'connectionId is required' };

    await deactivateBrokerConnection(userId, connectionId);
    const settings = await getUserTradingSettings(userId);
    if (settings.activeBrokerConnectionId === connectionId && settings.activeBroker) {
      await setActiveBroker({
        clerkUserId: userId,
        activeBroker: settings.activeBroker,
        activeEnvironment: 'practice',
        activeBrokerConnectionId: null,
      });
    }

    revalidatePath('/dashboard');
    revalidatePath('/dashboard/settings');
    revalidatePath('/dashboard/ftmo');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
