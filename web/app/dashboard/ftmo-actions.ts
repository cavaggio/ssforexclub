'use server';

import { auth, currentUser } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import { upsertUserFromClerk } from '@/lib/users';
import { saveFuturesConnection } from '@/lib/futuresProvider';
import type { BrokerEnvironment } from '@/lib/brokerConnections';

export type FtmoActionResult = { ok: true } | { ok: false; error: string };

function str(formData: FormData, key: string): string {
  return String(formData.get(key) || '').trim();
}

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

export async function saveFtmoConnectionAction(formData: FormData): Promise<FtmoActionResult> {
  try {
    const userId = await requireUserId();
    const environment = (str(formData, 'environment') || 'free_trial') as BrokerEnvironment;

    if (!['free_trial', 'challenge', 'verification', 'funded'].includes(environment)) {
      return { ok: false, error: 'FTMO environment must be free trial, challenge, verification, or funded' };
    }

    const credentials = {
      accountLogin: str(formData, 'accountLogin'),
      server: str(formData, 'server'),
      bridgeUrl: str(formData, 'bridgeUrl').replace(/\/+$/, ''),
      bridgeApiKey: str(formData, 'bridgeApiKey'),
      bridgeSecret: str(formData, 'bridgeSecret'),
      terminalId: str(formData, 'terminalId') || 'ftmo-primary',
    };

    const required = ['accountLogin', 'server', 'bridgeUrl', 'bridgeApiKey', 'bridgeSecret'] as const;
    const missing = required.filter((key) => !credentials[key]);

    if (missing.length) return { ok: false, error: `Missing required FTMO MT5 field(s): ${missing.join(', ')}` };
    if (!/^\d+$/.test(credentials.accountLogin)) return { ok: false, error: 'FTMO MT5 login must contain digits only' };
    if (credentials.bridgeSecret.length < 16) return { ok: false, error: 'Bridge secret must be at least 16 characters' };

    let bridgeUrl: URL;
    try {
      bridgeUrl = new URL(credentials.bridgeUrl);
    } catch {
      return { ok: false, error: 'Bridge URL must be a valid absolute URL' };
    }
    const local = ['localhost', '127.0.0.1', '::1'].includes(bridgeUrl.hostname);
    if (bridgeUrl.protocol !== 'https:' && !(bridgeUrl.protocol === 'http:' && local)) {
      return { ok: false, error: 'Bridge URL must use HTTPS' };
    }

    await saveFuturesConnection({
      clerkUserId: userId,
      provider: 'ftmo',
      environment,
      credentials,
    });

    revalidatePath('/dashboard/ftmo');
    revalidatePath('/dashboard/settings');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
