import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { resolveActiveBrokerForUser } from '@/lib/brokerResolver';
import { syncOandaTransactionsForUser } from '@/lib/oandaTransactionSync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated' }, { status: 401 });
  }

  const resolved = await resolveActiveBrokerForUser(userId);

  if (resolved.activeBroker !== 'oanda') {
    return NextResponse.json(
      { ok: false, error: 'OANDA transaction sync only supports OANDA accounts.' },
      { status: 409 },
    );
  }

  if (
    resolved.brokerCredentialStatus !== 'ready' ||
    !resolved.getCredentials ||
    !resolved.baseUrl
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: resolved.reason,
        brokerCredentialStatus: resolved.brokerCredentialStatus,
        activeEnvironment: resolved.activeEnvironment,
      },
      { status: 409 },
    );
  }

  const creds = await resolved.getCredentials();

  if (!creds) {
    return NextResponse.json({ ok: false, error: 'Could not decrypt OANDA credentials' }, { status: 500 });
  }

  const sync = await syncOandaTransactionsForUser({
    userId,
    brokerAccountId: creds.accountId,
    environment: resolved.activeEnvironment as 'practice' | 'live' | 'paper',
    baseUrl: resolved.baseUrl,
    token: creds.token,
  });

  return NextResponse.json({ ok: sync.ok, sync }, { status: sync.ok ? 200 : 500 });
}
