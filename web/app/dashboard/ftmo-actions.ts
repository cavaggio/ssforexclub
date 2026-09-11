'use server';

import { auth, currentUser } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import { upsertUserFromClerk } from '@/lib/users';
import { saveFuturesConnection } from '@/lib/futuresProvider';
import { generateMt5EaToken, registerMt5EaTerminal } from '@/lib/ftmoEaTerminal';
import type { BrokerEnvironment } from '@/lib/brokerConnections';

export type FtmoActionResult = { ok: true; terminalToken: string; terminalId: string } | { ok: false; error: string };

function str(formData: FormData, key: string): string {
  return String(formData.get(key) || '').trim();
}

async function requireUserId(): Promise<string> {
  const { userId } = await auth();
  if (!userId) throw new Error('Unauthenticated');
  const u = await currentUser();
  if (u) {
    await upsertUserFromClerk({ clerkUserId: u.id, email: u.primaryEmailAddress?.emailAddress ?? '' }).catch(() => undefined);
  }
  return userId;
}

export async function saveFtmoConnectionAction(formData: FormData): Promise<FtmoActionResult> {
  try {
    const userId = await requireUserId();
    const environment = (str(formData, 'environment') || 'challenge') as BrokerEnvironment;
    if (!['challenge', 'verification', 'funded'].includes(environment)) {
      return { ok: false, error: 'Environment must be challenge, verification, or funded' };
    }

    const accountLogin = str(formData, 'accountLogin');
    const server = str(formData, 'server');
    const terminalId = str(formData, 'terminalId') || 'ftmo-primary';
    if (!accountLogin || !server) return { ok: false, error: 'MT5 login and exact MT5 server are required' };
    if (!/^\d+$/.test(accountLogin)) return { ok: false, error: 'FTMO MT5 login must contain digits only' };

    const terminalToken = generateMt5EaToken();
    const credentials = { accountLogin, server, terminalId, terminalToken, adapter: 'mt5_ea' };

    await saveFuturesConnection({ clerkUserId: userId, provider: 'ftmo', environment, credentials });
    await registerMt5EaTerminal({ userId, accountLogin, server, terminalId, token: terminalToken });

    revalidatePath('/dashboard/ftmo');
    revalidatePath('/dashboard/settings');
    return { ok: true, terminalToken, terminalId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
