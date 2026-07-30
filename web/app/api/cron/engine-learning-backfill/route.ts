import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/db';
import { listBrokerConnectionsForUser } from '@/lib/brokerConnections';
import { backfillEngineLearningWindow } from '@/lib/engineLearningBackfill';
import { reconcileActualTradesForAccount } from '@/lib/actualTradeReconciliation';

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
      .select('user_id, auto_ai_engine')
      .eq('auto_ai_trading_enabled', true);
    if (error) throw error;

    const results: Record<string, unknown>[] = [];
    let accountsProcessed = 0;
    let engineProfilesProcessed = 0;
    let observationsConsidered = 0;
    let outcomesWritten = 0;
    let actualOpeningsConsidered = 0;
    let actualTradesFetched = 0;
    let actualTradesUpserted = 0;
    let actualClosedTrades = 0;

    for (const row of (settings || []) as Array<{ user_id: string; auto_ai_engine?: string | null }>) {
      const connections = await listBrokerConnectionsForUser(row.user_id);
      const activeAccounts = [...new Map(
        connections
          .filter((connection) => connection.isActive && connection.broker === 'oanda' && connection.accountId)
          .map((connection) => [connection.accountId, connection]),
      ).values()];

      if (!activeAccounts.length) {
        results.push({
          userId: row.user_id,
          configuredEngine: row.auto_ai_engine || null,
          skipped: 'no_active_oanda_accounts',
          reason: 'No active OANDA broker connections were available for historical learning.',
        });
        continue;
      }

      for (const account of activeAccounts) {
        accountsProcessed += 1;

        // Actual OANDA lifecycle reconciliation owns win/loss/P&L attribution.
        // It intentionally studies every recoverable historical opening for this
        // exact account/engine, including legacy pairs no longer on a watchlist.
        const actual = await reconcileActualTradesForAccount({
          userId: row.user_id,
          connectionId: account.id,
          brokerAccountId: account.accountId,
          calendarLookbackDays,
          now: startedAt,
        });
        actualOpeningsConsidered += actual.openingsConsidered;
        actualTradesFetched += actual.tradesFetched;
        actualTradesUpserted += actual.tradesUpserted;
        actualClosedTrades += actual.closedTrades;
        results.push({
          kind: 'actual_trade_lifecycle',
          userId: row.user_id,
          accountId: account.accountId,
          connectionId: account.id,
          broker: account.broker,
          environment: account.environment,
          validationStatus: account.validationStatus,
          configuredEngine: row.auto_ai_engine || null,
          ...actual,
        });

        // Keep the existing 15/30/60/120-minute forward market-path study as a
        // separate execution-quality layer for each engine/account.
        for (const engine of ENGINES as readonly Engine[]) {
          const result = await backfillEngineLearningWindow({
            userId: row.user_id,
            brokerAccountId: account.accountId,
            engine,
            tradingDays,
            calendarLookbackDays,
            now: startedAt,
          });
          engineProfilesProcessed += 1;
          observationsConsidered += result.observationsConsidered;
          outcomesWritten += result.outcomesWritten;
          results.push({
            kind: 'forward_market_path',
            userId: row.user_id,
            accountId: account.accountId,
            connectionId: account.id,
            broker: account.broker,
            environment: account.environment,
            validationStatus: account.validationStatus,
            configuredEngine: row.auto_ai_engine || null,
            ...result,
          });
        }
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
          actual_openings_considered: actualOpeningsConsidered,
          actual_trades_fetched: actualTradesFetched,
          actual_trades_upserted: actualTradesUpserted,
          actual_closed_trades: actualClosedTrades,
          results,
          error: failed.length ? `${failed.length} reconciliation/profile result(s) failed` : null,
        })
        .eq('id', runId);
    }

    console.log(
      `[ENGINE_LEARNING_BACKFILL] tradingDays=${tradingDays} accounts=${accountsProcessed} ` +
      `actualOpenings=${actualOpeningsConsidered} actualFetched=${actualTradesFetched} ` +
      `actualUpserted=${actualTradesUpserted} actualClosed=${actualClosedTrades} ` +
      `engineProfiles=${engineProfilesProcessed} observations=${observationsConsidered} ` +
      `forwardOutcomes=${outcomesWritten} status=${status}`,
    );

    return NextResponse.json({
      ok: status !== 'failed',
      runId,
      status,
      tradingDays,
      calendarLookbackDays,
      accountsProcessed,
      actualOpeningsConsidered,
      actualTradesFetched,
      actualTradesUpserted,
      actualClosedTrades,
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
