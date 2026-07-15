/**
 * web/app/dashboard/futures-actions.ts
 *
 * Server Actions for connecting futures providers. The primary futures slot
 * retains the legacy canonical provider value `ninjatrader` for database and
 * route compatibility, but now stores IBKR Gateway / bridge connection data.
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
    revalidatePath('/dashboard/ftmo');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Interactive Brokers ─────────────────────────────────────────────────────
export async function saveIbkrConnectionAction(formData: FormData): Promise<ActionResult> {
  const environment = (str(formData, 'environment') || 'paper') as BrokerEnvironment;
  if (environment !== 'paper' && environment !== 'live') {
    return { ok: false, error: 'IBKR environment must be paper or live' };
  }
  return saveFutures('ninjatrader', environment, {
    accountId: str(formData, 'accountId').toUpperCase(),
    gatewayUrl: str(formData, 'gatewayUrl').replace(/\/+$/, ''),
    bridgeToken: str(formData, 'bridgeToken'),
    clientId: str(formData, 'clientId') || '7',
    providerLabel: 'ibkr',
  });
}

// Legacy action kept temporarily so old clients fail with an explicit message
// instead of silently saving obsolete Tradovate credentials.
export async function saveNinjaTraderConnectionAction(): Promise<ActionResult> {
  return { ok: false, error: 'NinjaTrader / Tradovate has been replaced by Interactive Brokers on the Futures tab.' };
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
