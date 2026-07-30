import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/db';
import { resolveActiveBrokerForUser } from '@/lib/brokerResolver';
import { backfillEngineLearningWindow } from '@/lib/engineLearningBackfill';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ENGINES = ['ict', 'ppr', 'v3'] as const;
type Engine = typeof ENGINES[number];

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

export async function POST(req: Request) {
  const secret = process.env.AUTO_AI_CRON_SECRET;
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch {}

  const tradingDays = boundedInteger(body.tradingDays, 7, 1, 30);
  const calendarLookbackDays = boundedInteger(body.calendarLookbackDays, 14, tradingDays, 60);
  const source = typeof body.source === 'string' && body.source.trim() ? body.source.trim() : 'scheduler';
  const startedAt = new Date();
  const supabase = getServerSupabase();

  let runId: string | null = null;
  try {
    const { data } = await supabase
      .from('engine_learning_backfill_runs')
      .insert({
        requested_trading_days: tradingDays,
        calendar_lookback_days: calendarLookbackDays,
        source,
        status: 'running',
      })
      .select('id')
      .maybeSingle();
    runId = data?.id ? String(data.id) : null;
  } catch {}

  try {
    const { data: settings, error } = await supabase
      .from('user_trading_settings')
      .select('user_id')
      .eq('auto_ai_trading_enabled', true);
    if (error) throw error;

    const results: Record<string, unknown>[] = [];
    let accountsProcessed = 0;
    let engineProfilesProcessed = 0;
    let observationsConsidered = 0;
    let outcomesWritten = 0;

    for (const row of (settings || []) as Array<{ user_id: string }>) {
      const resolved = await resolveActiveBrokerForUser(row.user_id);
      if (resolved.brokerCredentialStatus !== 'ready' || !resolved.getCredentials) {
        results.push({
          userId: row.user_id,
          skipped: resolved.brokerCredentialStatus,
          reason: resolved.reason,
        });
        continue;
      }

      const credentials = await resolved.getCredentials();
      if (!credentials?.accountId) {
        results.push({ userId: row.user_id, skipped: 'credentials_unavailable' });
        continue;
      }

      accountsProcessed += 1;
      for (const engine of ENGINES as readonly Engine[]) {
        const result = await backfillEngineLearningWindow({
          userId: row.user_id,
          brokerAccountId: credentials.accountId,
          engine,
          tradingDays,
          calendarLookbackDays,
          now: startedAt,
        });
        engineProfilesProcessed += 1;
        observationsConsidered += result.observationsConsidered;
        outcomesWritten += result.outcomesWritten;
        results.push({
          userId: row.user_id,
          accountId: credentials.accountId,
          environment: resolved.activeEnvironment,
          ...result,
        });
      }
    }

    const failed = results.filter((item) => item && typeof item === 'object' && (item as { ok?: boolean }).ok === false);
    const status = failed.length ? (failed.length === results.length ? 'failed' : 'partial') : 'completed';
    if (runId) {
      await supabase
        .from('engine_learning_backfill_runs')
        .update({
          completed_at: new Date().toISOString(),
          status,
          accounts_processed: accountsProcessed,
          engine_profiles_processed: engineProfilesProcessed,
          observations_considered: observationsConsidered,
          outcomes_written: outcomesWritten,
          results,
          error: failed.length ? `${failed.length} engine profile(s) failed` : null,
        })
        .eq('id', runId);
    }

    console.log(
      `[ENGINE_LEARNING_BACKFILL] tradingDays=${tradingDays} accounts=${accountsProcessed} ` +
      `engineProfiles=${engineProfilesProcessed} observations=${observationsConsidered} outcomes=${outcomesWritten} status=${status}`,
    );

    return NextResponse.json({
      ok: status !== 'failed',
      runId,
      status,
      tradingDays,
      calendarLookbackDays,
      accountsProcessed,
      engineProfilesProcessed,
      observationsConsidered,
      outcomesWritten,
      results,
    }, { status: status === 'failed' ? 500 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (runId) {
      await supabase
        .from('engine_learning_backfill_runs')
        .update({ completed_at: new Date().toISOString(), status: 'failed', error: message })
        .eq('id', runId);
    }
    return NextResponse.json({ ok: false, runId, error: message }, { status: 500 });
  }
}
