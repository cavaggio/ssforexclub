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

  if (!userId) {
    throw new Error('Unauthenticated');
  }

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

    const environment = (str(formData, 'environment') || 'challenge') as BrokerEnvironment;

    if (!['challenge', 'verification', 'funded'].includes(environment)) {
      return { ok: false, error: 'FTMO environment must be challenge, verification, or funded' };
    }

    const credentials = {
      accountId: str(formData, 'accountId'),
      clientId: str(formData, 'clientId'),
      clientSecret: str(formData, 'clientSecret'),
      accessToken: str(formData, 'accessToken'),
      refreshToken: str(formData, 'refreshToken'),
      apiBaseUrl: str(formData, 'apiBaseUrl'),
    };

    const missing = Object.entries(credentials)
      .filter(([key, value]) => key !== 'apiBaseUrl' && !value)
      .map(([key]) => key);

    if (missing.length) {
      return { ok: false, error: `Missing required FTMO field(s): ${missing.join(', ')}` };
    }

    await saveFuturesConnection({
      clerkUserId: userId,
      provider: 'ftmo',
      environment,
      credentials,
    });

    revalidatePath('/dashboard/ftmo');

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
