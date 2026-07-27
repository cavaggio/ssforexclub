import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/db';
import { resolveActiveBrokerForUser } from '@/lib/brokerResolver';
import { refreshPairPlaybooksForAccount } from '@/lib/signalLearning';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ENGINES = ['v3', 'ict', 'ppr'] as const;
type Engine = typeof ENGINES[number];

function engineOf(value: unknown): Engine {
  const engine = String(value || 'ict').toLowerCase();
  return ENGINES.includes(engine as Engine) ? engine as Engine : 'ict';
}

export async function POST(req: Request) {
  const secret = process.env.AUTO_AI_CRON_SECRET;
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch {}
  const requestedUser = typeof body.userId === 'string' ? body.userId : null;
  const requestedEngine = typeof body.engine === 'string' ? engineOf(body.engine) : null;

  try {
    let query = getServerSupabase()
      .from('user_trading_settings')
      .select('user_id,auto_ai_engine')
      .eq('auto_ai_trading_enabled', true);
    if (requestedUser) query = query.eq('user_id', requestedUser);
    const { data, error } = await query;
    if (error) throw error;

    const results: Record<string, unknown>[] = [];
    for (const row of data || []) {
      const engine = requestedEngine || engineOf(row.auto_ai_engine);
      try {
        const resolved = await resolveActiveBrokerForUser(row.user_id);
        if (resolved.brokerCredentialStatus !== 'ready' || !resolved.getCredentials) {
          results.push({ userId: row.user_id, engine, ok: false, skipped: resolved.brokerCredentialStatus, reason: resolved.reason });
          continue;
        }
        const credentials = await resolved.getCredentials();
        if (!credentials?.accountId) {
          results.push({ userId: row.user_id, engine, ok: false, skipped: 'decrypt_failed' });
          continue;
        }
        const refreshed = await refreshPairPlaybooksForAccount({
          userId: row.user_id,
          brokerAccountId: credentials.accountId,
          engine,
        });
        results.push({ userId: row.user_id, accountId: credentials.accountId, engine, ...refreshed });
      } catch (userError) {
        results.push({
          userId: row.user_id,
          engine,
          ok: false,
          error: userError instanceof Error ? userError.message : String(userError),
        });
      }
    }

    return NextResponse.json({
      ok: results.every((result) => result.ok === true || Boolean(result.skipped)),
      users: results.length,
      liveThresholdsChanged: false,
      results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[EDGE_LEARNING_CRON] failed:', message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
