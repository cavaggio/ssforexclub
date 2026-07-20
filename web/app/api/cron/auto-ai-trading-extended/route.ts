import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/db';
import { resolveActiveBrokerForUser } from '@/lib/brokerResolver';
import { callInternalEndpoint } from '@/lib/scannerProxy';
import { logTradeEvent } from '@/lib/tradeLogs';
import { edgeSnapshotFromSignal } from '@/lib/edgeSnapshot';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type ScanMode = 'full' | 'near_recheck' | 'hot_watch';
type AutoAiEngine = 'ict' | 'v3' | 'ppr';

const AUTO_AI_ENGINES: readonly AutoAiEngine[] = ['ict', 'v3', 'ppr'];

function inWindow(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
  }).formatToParts(now);
  const read = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  const weekday = read('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const minutes = (parseInt(read('hour'), 10) % 24) * 60 + parseInt(read('minute'), 10);
  return minutes >= 2 * 60 && minutes < 10 * 60;
}

function normalizeMode(value: unknown): ScanMode {
  const mode = String(value || 'full').toLowerCase();
  return mode === 'near_recheck' || mode === 'hot_watch' ? mode : 'full';
}

function normalizeEngine(value: unknown): AutoAiEngine {
  if (value === 'v3' || value === 'ppr') return value;
  return 'ict';
}

function executionOrder(preferredValue: unknown): AutoAiEngine[] {
  const preferred = normalizeEngine(preferredValue);
  return [preferred, ...AUTO_AI_ENGINES.filter((engine) => engine !== preferred)];
}

function normalizePairs(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map((v) => String(v || '').trim()).filter(Boolean))] : [];
}

function addPairs(target: Set<string>, value: unknown) {
  if (!Array.isArray(value)) return;
  for (const pair of value) if (String(pair || '').trim()) target.add(String(pair).trim());
}

export async function POST(req: Request) {
  const secret = process.env.AUTO_AI_CRON_SECRET;
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (!inWindow()) return NextResponse.json({ ok: true, skipped: 'outside_ny_entry_window' });

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch {}
  const runId = typeof body.runId === 'string' ? body.runId : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const scanMode = normalizeMode(body.scanMode);
  const pairs = normalizePairs(body.pairs);
  if ((scanMode === 'near_recheck' || scanMode === 'hot_watch') && pairs.length === 0) {
    return NextResponse.json({ ok: true, runId, scanMode, skipped: 'no_pairs' });
  }

  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('user_trading_settings')
    .select('user_id, auto_ai_engine')
    .eq('auto_ai_trading_enabled', true);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const near = new Set<string>();
  const hot = new Set<string>();
  const late = new Set<string>();
  const results: Record<string, unknown>[] = [];
  let qualified = 0;
  let executed = 0;
  let skipped = 0;

  for (const row of (data ?? []) as Array<{ user_id: string; auto_ai_engine?: string }>) {
    try {
      const resolved = await resolveActiveBrokerForUser(row.user_id);
      if (resolved.brokerCredentialStatus !== 'ready' || !resolved.getCredentials || !resolved.baseUrl) {
        results.push({ user: row.user_id, skipped: resolved.brokerCredentialStatus });
        continue;
      }
      const credentials = await resolved.getCredentials();
      if (!credentials) {
        results.push({ user: row.user_id, skipped: 'decrypt_failed' });
        continue;
      }

      const preferredEngine = normalizeEngine(row.auto_ai_engine);
      const engineResults: Record<string, unknown>[] = [];

      // Run engines sequentially so shared duplicate locks, open-risk limits, daily
      // loss budgets, and trade caps are re-evaluated after every successful order.
      for (const engine of executionOrder(preferredEngine)) {
        try {
          const result = await callInternalEndpoint('/api/internal/oanda/auto', {
            apiKey: credentials.token,
            accountId: credentials.accountId,
            baseUrl: resolved.baseUrl,
            environment: resolved.activeEnvironment,
            runId: `${runId}-${engine}`,
            scanMode,
            pairs,
            engine,
          });
          if (!result.ok) {
            engineResults.push({ engine, error: result.error, status: result.status });
            continue;
          }

          const payload = (result.data ?? {}) as Record<string, any>;
          const executedList = Array.isArray(payload.executed) ? payload.executed : [];
          qualified += Number(payload.qualified ?? 0);
          executed += executedList.length;
          skipped += Array.isArray(payload.skipped) ? payload.skipped.length : 0;
          addPairs(near, payload.nearQualifiedPairs);
          addPairs(hot, payload.hotPairs);
          addPairs(late, payload.lateEntryPairs);

          for (const item of executedList) {
            const signal = item?.signal && typeof item.signal === 'object' ? item.signal : item;
            await logTradeEvent({
              userId: row.user_id,
              broker: (resolved.activeBroker ?? 'oanda') as 'oanda',
              brokerAccountId: credentials.accountId,
              environment: resolved.activeEnvironment as 'practice' | 'live' | 'paper',
              eventType: 'opened',
              engine,
              strategy: typeof item?.strategy === 'string' ? item.strategy : engine.toUpperCase(),
              brokerTradeId: typeof item?.tradeId === 'string' ? item.tradeId : null,
              instrument: typeof item?.pair === 'string' ? item.pair : null,
              tradeId: typeof item?.tradeId === 'string' ? item.tradeId : null,
              brokerOrderId: typeof item?.tradeId === 'string' ? item.tradeId : null,
              side: item?.direction === 'long' || item?.direction === 'short' ? item.direction : null,
              units: typeof item?.units === 'number' ? Math.abs(item.units) : null,
              entryPrice: typeof item?.fillPrice === 'number' ? item.fillPrice : null,
              sl: typeof item?.stopLoss === 'number' ? item.stopLoss : null,
              tp: typeof item?.takeProfit === 'number' ? item.takeProfit : null,
              confidence: typeof item?.confidence === 'number' ? item.confidence : null,
              recommendation: typeof item?.expectedRR === 'number' ? `RR ${item.expectedRR}` : `${engine.toUpperCase()}_AUTO`,
              reason: `Auto AI ${engine.toUpperCase()} opened trade during all-engine run ${runId}`,
              rawPayload: { runId, scanMode, engine, executionMode: 'all_engines_sequential', item },
              edge: edgeSnapshotFromSignal(signal),
            });
          }

          engineResults.push({ engine, result: payload });
        } catch (engineError) {
          engineResults.push({
            engine,
            error: engineError instanceof Error ? engineError.message : String(engineError),
          });
        }
      }

      results.push({
        user: row.user_id,
        preferredEngine,
        executionMode: 'all_engines_sequential',
        engines: engineResults,
      });
    } catch (err) {
      results.push({ user: row.user_id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return NextResponse.json({
    ok: true,
    runId,
    scanMode,
    pairs,
    users: results.length,
    qualified,
    executed,
    skipped,
    executionMode: 'all_engines_sequential',
    enabledEngines: AUTO_AI_ENGINES,
    nearQualifiedPairs: [...near],
    hotPairs: [...hot],
    lateEntryPairs: [...late],
    entryWindow: '02:00-10:00 America/New_York, Monday-Friday',
    results,
  });
}
