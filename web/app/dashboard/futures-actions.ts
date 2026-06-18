/**
 * web/app/dashboard/futures-actions.ts
 *
 * Server Actions for connecting the futures providers (NinjaTrader, Topstep).
 * Same security contract as the OANDA broker actions:
 *   - run server-only
 *   - derive userId from the Clerk session, never from form data
 *   - validate + encrypt credentials before persistence
 *   - never echo secrets back to the browser
 */

'use server';

import { auth, currentUser } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import { upsertUserFromClerk } from '@/lib/users';
import {
  saveFuturesConnection,
  validateFuturesCredentials,
  type FuturesProvider,
} from '@/lib/futuresProvider';
import type { BrokerEnvironment } from '@/lib/brokerConnections';

export type ActionResult = { ok: true } | { ok: false; error: string };

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

function str(formData: FormData, key: string): string {
  return String(formData.get(key) || '').trim();
}

async function saveFutures(
  provider: FuturesProvider,
  environment: BrokerEnvironment,
  credentials: Record<string, string>,
): Promise<ActionResult> {
  try {
    const userId = await requireUserId();
    const check = validateFuturesCredentials(provider, credentials);
    if (!check.ok) return { ok: false, error: check.error ?? 'Invalid credentials' };

    await saveFuturesConnection({ clerkUserId: userId, provider, environment, credentials });

    revalidatePath('/dashboard/futures');
    revalidatePath('/dashboard/topstep');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── NinjaTrader ────────────────────────────────────────────────────────────
export async function saveNinjaTraderConnectionAction(formData: FormData): Promise<ActionResult> {
  const environment = (str(formData, 'environment') || 'paper') as BrokerEnvironment;
  if (environment !== 'paper' && environment !== 'live') {
    return { ok: false, error: 'NinjaTrader environment must be paper or live' };
  }
  return saveFutures('ninjatrader', environment, {
    name: str(formData, 'name'),
    password: str(formData, 'password'),
    appId: str(formData, 'appId'),
    appVersion: str(formData, 'appVersion'),
    cid: str(formData, 'cid'),
    sec: str(formData, 'sec'),
  });
}

// ─── Topstep ──────────────────────────────────────────────────────────────────
export async function saveTopstepConnectionAction(formData: FormData): Promise<ActionResult> {
  const environment = (str(formData, 'environment') || 'evaluation') as BrokerEnvironment;
  if (environment !== 'evaluation' && environment !== 'funded') {
    return { ok: false, error: 'Topstep environment must be evaluation or funded' };
  }
  return saveFutures('topstep', environment, {
    userName: str(formData, 'userName'),
    apiKey: str(formData, 'apiKey'),
  });
}
