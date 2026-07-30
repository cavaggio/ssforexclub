import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/db';
import {
  getDecryptedBrokerCredentials,
  listBrokerConnectionsForUser,
  resolveBrokerBaseUrl,
} from '@/lib/brokerConnections';
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
  let syncedAccounts = 0;
  let closeEvents = 0;
  let logged = 0;
  let failed = 0;

  for (const row of rows) {
    const userId = row.user_id;

    try {
      const connections = await listBrokerConnectionsForUser(userId);
      const accounts = [...new Map(
        connections
          .filter((connection) => connection.isActive && connection.broker === 'oanda' && connection.accountId)
          .map((connection) => [connection.accountId, connection]),
      ).values()];

      if (!accounts.length) {
        results.push({ user: mask(userId), skipped: 'no_active_oanda_accounts' });
        continue;
      }

      let userSynced = false;
      for (const account of accounts) {
        try {
          const creds = await getDecryptedBrokerCredentials(userId, account.id);
          if (!creds || creds.broker !== 'oanda' || creds.accountId !== account.accountId) {
            failed += 1;
            results.push({
              user: mask(userId),
              account: mask(account.accountId),
              skipped: 'credentials_unavailable',
            });
            continue;
          }

          const sync = await syncOandaTransactionsForUser({
            userId,
            brokerAccountId: creds.accountId,
            environment: creds.environment as 'practice' | 'live' | 'paper',
            baseUrl: resolveBrokerBaseUrl(creds.broker, creds.environment),
            token: creds.token,
          });

          syncedAccounts += 1;
          userSynced = true;
          closeEvents += sync.closeEvents;
          logged += sync.logged;
          failed += sync.failed;

          results.push({
            user: mask(userId),
            account: mask(account.accountId),
            connectionId: account.id,
            environment: account.environment,
            validationStatus: account.validationStatus,
            sync,
          });
        } catch (err) {
          failed += 1;
          results.push({
            user: mask(userId),
            account: mask(account.accountId),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (userSynced) syncedUsers += 1;
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
    syncedAccounts,
    closeEvents,
    logged,
    failed,
    results,
  });
}
