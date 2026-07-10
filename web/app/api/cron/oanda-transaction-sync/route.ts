import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/db';
import { resolveActiveBrokerForUser } from '@/lib/brokerResolver';
import { syncOandaTransactionsForUser } from '@/lib/oandaTransactionSync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const mask = (id: string) => (id && id.length > 6 ? `${id.slice(0, 4)}…${id.slice(-2)}` : '***');

export async function POST(req: Request) {
  const secret = process.env.AUTO_AI_CRON_SECRET;

  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = getServerSupabase();

  const { data, error } = await supabase
    .from('user_trading_settings')
    .select('user_id');

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as Array<{ user_id: string }>;
  const results: Record<string, unknown>[] = [];

  let syncedUsers = 0;
  let closeEvents = 0;
  let logged = 0;
  let failed = 0;

  for (const row of rows) {
    const userId = row.user_id;

    try {
      const resolved = await resolveActiveBrokerForUser(userId);

      if (resolved.activeBroker !== 'oanda') {
        results.push({ user: mask(userId), skipped: 'not_oanda' });
        continue;
      }

      if (
        resolved.brokerCredentialStatus !== 'ready' ||
        !resolved.getCredentials ||
        !resolved.baseUrl
      ) {
        results.push({
          user: mask(userId),
          skipped: resolved.brokerCredentialStatus,
          reason: resolved.reason,
        });
        continue;
      }

      const creds = await resolved.getCredentials();

      if (!creds) {
        results.push({ user: mask(userId), skipped: 'decrypt_failed' });
        continue;
      }

      const sync = await syncOandaTransactionsForUser({
        userId,
        brokerAccountId: creds.accountId,
        environment: resolved.activeEnvironment as 'practice' | 'live' | 'paper',
        baseUrl: resolved.baseUrl,
        token: creds.token,
      });

      syncedUsers += 1;
      closeEvents += sync.closeEvents;
      logged += sync.logged;
      failed += sync.failed;

      results.push({ user: mask(userId), sync });
    } catch (err) {
      failed += 1;
      results.push({
        user: mask(userId),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    users: rows.length,
    syncedUsers,
    closeEvents,
    logged,
    failed,
    results,
  });
}
