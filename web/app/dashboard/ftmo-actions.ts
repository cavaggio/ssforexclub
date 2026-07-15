'use server';

import { auth, currentUser } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import { upsertUserFromClerk } from '@/lib/users';
import { saveFuturesConnection, type FtmoPlatform } from '@/lib/futuresProvider';
import type { BrokerEnvironment } from '@/lib/brokerConnections';

export type FtmoActionResult = { ok: true } | { ok: false; error: string };

function str(formData: FormData, key: string): string {
  return String(formData.get(key) || '').trim();
}

function missingFields(
  credentials: Record<string, string>,
  labels: Record<string, string>,
): string[] {
  return Object.entries(credentials)
    .filter(([, value]) => !value)
    .map(([key]) => labels[key] || key);
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
    const platform = str(formData, 'platform').toLowerCase() as FtmoPlatform;
    const accountId = str(formData, 'accountId');

    if (!['challenge', 'verification', 'funded'].includes(environment)) {
      return { ok: false, error: 'FTMO environment must be challenge, verification, or funded' };
    }

    if (!['ctrader', 'mt5', 'mt4'].includes(platform)) {
      return { ok: false, error: 'Choose cTrader, MetaTrader 5, or MetaTrader 4' };
    }

    let credentials: Record<string, string>;

    if (platform === 'ctrader') {
      credentials = {
        platform,
        connector: 'ctrader-open-api',
        accountId,
        accessToken: str(formData, 'accessToken'),
        refreshToken: str(formData, 'refreshToken'),
      };

      const missing = missingFields(credentials, {
        platform: 'platform',
        connector: 'connector',
        accountId: 'cTrader account ID',
        accessToken: 'cTrader access token',
        refreshToken: 'cTrader refresh token',
      });

      if (missing.length) {
        return { ok: false, error: `Missing required FTMO field(s): ${missing.join(', ')}` };
      }
    } else {
      credentials = {
        platform,
        connector: 'metaapi',
        accountId,
        server: str(formData, 'server'),
        bridgeAccountId: str(formData, 'bridgeAccountId'),
        bridgeToken: str(formData, 'bridgeToken'),
      };

      const missing = missingFields(credentials, {
        platform: 'platform',
        connector: 'connector',
        accountId: 'FTMO account login',
        server: 'FTMO server',
        bridgeAccountId: 'MetaApi account ID',
        bridgeToken: 'MetaApi API token',
      });

      if (missing.length) {
        return { ok: false, error: `Missing required FTMO field(s): ${missing.join(', ')}` };
      }
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
