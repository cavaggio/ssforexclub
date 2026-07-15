/**
 * web/app/dashboard/actions.ts
 *
 * Server Actions for the dashboard. All three actions:
 *   1. Run server-only (the `'use server'` directive).
 *   2. Derive userId from `(await auth()).userId` — NEVER from form data.
 *   3. Re-validate the dashboard route on success so the new state is
 *      reflected on the next render.
 *
 * Public actions:
 *   saveBrokerConnectionAction     — create or upsert an OANDA / Alpaca conn
 *   setActiveTradingModeAction     — flip between practice/paper/live
 *   acknowledgeLiveTradingAction   — one-time risk acceptance
 *   removeBrokerConnectionAction   — deactivate a connection (soft delete)
 */

'use server';

import { auth } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
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
import { currentUser } from '@clerk/nextjs/server';

export type ActionResult = { ok: true } | { ok: false; error: string };

const OANDA_ACCOUNT_ID_PATTERN = /^\d{3}-\d{3}-\d{6,12}-\d{3}$/;

async function requireUserId(): Promise<string> {
  const { userId } = await auth();
  if (!userId) throw new Error('Unauthenticated');
  // Make sure the shadow-user row exists before we FK off it.
  const u = await currentUser();
  if (u) {
    await upsertUserFromClerk({
      clerkUserId: u.id,
      email: u.primaryEmailAddress?.emailAddress ?? '',
    }).catch(() => undefined);
  }
  return userId;
}

// ─── saveBrokerConnectionAction ─────────────────────────────────────────────
// Atomic upsert: reconnecting the same (user, broker, environment, account_id)
// refreshes credentials, reactivates the row, and resets validation to pending.
// Never deactivate first — a later write failure must not strand the account.
export async function saveBrokerConnectionAction(formData: FormData): Promise<ActionResult> {
  try {
    const userId = await requireUserId();

    const broker = String(formData.get('broker') || '').toLowerCase() as BrokerKind;
    const environment = String(formData.get('environment') || '').toLowerCase() as BrokerEnvironment;
    const accountId = String(formData.get('accountId') || '').trim();
    const token = String(formData.get('token') || '').trim();
    const secret = String(formData.get('secret') || '').trim() || null;

    if (broker !== 'oanda' && broker !== 'alpaca') {
      return { ok: false, error: 'Broker must be oanda or alpaca' };
    }
    if (!['practice', 'paper', 'live'].includes(environment)) {
      return { ok: false, error: 'Environment must be practice, paper, or live' };
    }
    if (!accountId) return { ok: false, error: 'Account ID is required' };
    if (!token)     return { ok: false, error: 'API token is required' };
    if (broker === 'oanda' && !OANDA_ACCOUNT_ID_PATTERN.test(accountId)) {
      return {
        ok: false,
        error: 'Enter your OANDA account ID, not your email address. Example: 101-001-39311050-001.',
      };
    }

    await createBrokerConnection({
      clerkUserId: userId,
      broker,
      accountId,
      environment,
      token,
      secret,
    });

    revalidatePath('/dashboard');
    revalidatePath('/dashboard/settings');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── setActiveTradingModeAction ─────────────────────────────────────────────
// The user-facing toggle. Hard rules (Part 7):
//   - Cannot flip to live without `live_trading_acknowledged=true`.
//   - Cannot flip to a mode that has no matching active broker_connection
//     (we'd rather error than silently swap).
export async function setActiveTradingModeAction(formData: FormData): Promise<ActionResult> {
  try {
    const userId = await requireUserId();
    const broker = String(formData.get('broker') || '').toLowerCase() as ActiveBroker;
    const environment = String(formData.get('environment') || '').toLowerCase() as ActiveEnvironment;

    if (broker !== 'oanda' && broker !== 'alpaca') {
      return { ok: false, error: 'Broker must be oanda or alpaca' };
    }
    if (!['practice', 'paper', 'live'].includes(environment)) {
      return { ok: false, error: 'Environment must be practice, paper, or live' };
    }

    const settings = await getUserTradingSettings(userId);
    if (environment === 'live' && !settings.liveTradingAcknowledged) {
      return { ok: false, error: 'You must acknowledge the live-trading risk warning before activating live mode' };
    }

    // Find a matching active broker_connection for the target mode.
    const connections = await listBrokerConnectionsForUser(userId);
    const conn = connections.find(
      (c) => c.broker === broker && c.environment === environment && c.isActive
    );
    if (!conn) {
      const friendly = environment === 'live'
        ? `No live ${broker.toUpperCase()} credentials connected — link a live account before activating live mode`
        : `No ${environment} ${broker.toUpperCase()} credentials connected — link a ${environment} account first`;
      return { ok: false, error: friendly };
    }

    await setActiveBroker({
      clerkUserId: userId,
      activeBroker: broker,
      activeEnvironment: environment,
      activeBrokerConnectionId: conn.id,
    });

    revalidatePath('/dashboard');
    revalidatePath('/dashboard/settings');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── acknowledgeLiveTradingAction ───────────────────────────────────────────
// One-time acceptance of the live-trading risk warning. Does NOT activate
// live mode by itself — the user still has to flip the toggle separately.
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

// ─── removeBrokerConnectionAction ───────────────────────────────────────────
// Soft delete — the row stays in the DB (audit) but is_active becomes false.
// If the deactivated row was the user's currently-active one, the trading
// settings are reset so the user must reconfirm.
export async function removeBrokerConnectionAction(formData: FormData): Promise<ActionResult> {
  try {
    const userId = await requireUserId();
    const connectionId = String(formData.get('connectionId') || '').trim();
    if (!connectionId) return { ok: false, error: 'connectionId is required' };

    await deactivateBrokerConnection(userId, connectionId);

    // If this was the active connection, clear the pointer to avoid stale state.
    const settings = await getUserTradingSettings(userId);
    if (settings.activeBrokerConnectionId === connectionId && settings.activeBroker) {
      await setActiveBroker({
        clerkUserId: userId,
        activeBroker: settings.activeBroker,
        activeEnvironment: 'practice',     // safe default
        activeBrokerConnectionId: null,
      });
    }

    revalidatePath('/dashboard');
    revalidatePath('/dashboard/settings');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
