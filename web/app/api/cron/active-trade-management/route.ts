import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/db';
import { resolveActiveBrokerForUser } from '@/lib/brokerResolver';
import { callInternalEndpoint } from '@/lib/scannerProxy';
import { listTradeLogsForUser } from '@/lib/tradeLogs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const mask = (id: string) => id && id.length > 6 ? `${id.slice(0, 4)}…${id.slice(-2)}` : '***';

type AutoAiEngine = 'ict' | 'v3' | 'ppr';

function normalizeEngine(value: unknown): AutoAiEngine {
  if (value === 'v3' || value === 'ppr') return value;
  return 'ict';
}

function nyContext(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const read = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  const weekday = read('weekday');
  const minutes = (parseInt(read('hour'), 10) % 24) * 60 + parseInt(read('minute'), 10);
  return {
    weekday,
    minutes,
    isWeekend: weekday === 'Sat' || weekday === 'Sun',
    afterEntryCutoff: minutes >= 10 * 60,
    beforeManagementEnd: minutes < 17 * 60 + 30,
    afterVolatilityCutoff: minutes >= 17 * 60,
  };
}

function shouldClose(plan: Record<string, any>, afterVolatilityCutoff: boolean) {
  const reversalRisk = String(
    plan.reversalRisk ??
    plan.detail?.invalidation?.reversalRisk ??
    plan.detail?.trendWeakening?.severity ??
    plan.trendWeakeningSeverity ??
    '',
  ).toLowerCase();
  const momentum = String(plan.momentumStatus ?? '').toLowerCase();
  const action = String(plan.recommendedAction ?? '').toUpperCase();
  const lifecycleAction = String(plan.lifecycleRecommendation?.action ?? '').toUpperCase();
  const mediumOrHigherReversal =
    reversalRisk === 'medium' || reversalRisk === 'high' ||
    momentum.includes('reversal') || momentum.includes('reversed');
  const immediateExit =
    plan.invalidationDetected === true ||
    action === 'EXIT_INVALIDATED' || action === 'EXIT_REVIEW' ||
    lifecycleAction.includes('EXIT') || lifecycleAction.includes('CLOSE') ||
    mediumOrHigherReversal;
  const slowedByFive = afterVolatilityCutoff && (
    plan.volatilityCollapsed === true ||
    momentum.includes('decay') || momentum.includes('slowing') ||
    plan.trendWeakeningDetected === true
  );
  return {
    close: immediateExit || slowedByFive,
    reason: immediateExit
      ? 'medium_or_higher_reversal_or_invalidation'
      : slowedByFive
        ? '5pm_et_volatility_or_momentum_slowdown'
        : null,
  };
}

function rawPayload(row: Record<string, unknown>): Record<string, any> {
  return row.raw_payload && typeof row.raw_payload === 'object'
    ? row.raw_payload as Record<string, any>
    : {};
}

function eventStrategy(row: Record<string, unknown>): string {
  const raw = rawPayload(row);
  const item = raw.item && typeof raw.item === 'object' ? raw.item : {};
  const signal = item.signal && typeof item.signal === 'object' ? item.signal : {};
  return String(
    raw.engine ?? raw.strategy ?? item.engine ?? item.strategy ?? signal.engine ?? signal.strategy ?? '',
  ).toLowerCase();
}

function eventTradeId(row: Record<string, unknown>): string {
  const raw = rawPayload(row);
  const item = raw.item && typeof raw.item === 'object' ? raw.item : {};
  const executed = raw.executed && typeof raw.executed === 'object' ? raw.executed : {};
  const request = raw.request && typeof raw.request === 'object' ? raw.request : {};
  const result = raw.result && typeof raw.result === 'object' ? raw.result : {};
  return String(
    row.trade_id ?? raw.tradeId ?? raw.trade_id ?? item.tradeId ?? item.trade_id ??
    executed.tradeId ?? request.tradeId ?? result.tradeId ?? '',
  );
}

async function openPprTradeIds(userId: string): Promise<Set<string>> {
  const fallback = { rows: [] as unknown[] };
  const { rows } = await listTradeLogsForUser(userId, { limit: 200 }).catch(() => fallback);
  const latestByTrade = new Map<string, Record<string, unknown>>();

  for (const rawRow of rows as Array<Record<string, unknown>>) {
    const tradeId = eventTradeId(rawRow);
    if (!tradeId) continue;
    const current = latestByTrade.get(tradeId);
    const timestamp = Date.parse(String(rawRow.created_at ?? '')) || 0;
    const currentTimestamp = Date.parse(String(current?.created_at ?? '')) || 0;
    if (!current || timestamp > currentTimestamp) latestByTrade.set(tradeId, rawRow);
  }

  const ids = new Set<string>();
  for (const [tradeId, row] of latestByTrade) {
    if (row.event_type === 'opened' && eventStrategy(row) === 'ppr') ids.add(tradeId);
  }
  return ids;
}

export async function POST(req: Request) {
  const secret = process.env.AUTO_AI_CRON_SECRET;
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const ny = nyContext();
  if (ny.isWeekend || !ny.afterEntryCutoff || !ny.beforeManagementEnd) {
    return NextResponse.json({ ok: true, skipped: 'outside_management_window_10:00-17:30_ET', ny });
  }

  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('user_trading_settings')
    .select('user_id, auto_ai_engine')
    .eq('auto_ai_trading_enabled', true);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const results: Record<string, unknown>[] = [];
  let reviewed = 0;
  let closed = 0;

  for (const row of (data ?? []) as Array<{ user_id: string; auto_ai_engine?: string }>) {
    const userId = row.user_id;
    const engine = normalizeEngine(row.auto_ai_engine);

    try {
      const pprTradeIds = await openPprTradeIds(userId);

      if (engine === 'ppr') {
        results.push({
          user: mask(userId),
          engine,
          protectedPprTradeIds: [...pprTradeIds],
          skipped: 'ppr_native_management_not_configured_sl_tp_only',
        });
        continue;
      }

      const resolved = await resolveActiveBrokerForUser(userId);
      if (resolved.brokerCredentialStatus !== 'ready' || !resolved.getCredentials || !resolved.baseUrl) {
        results.push({ user: mask(userId), engine, skipped: resolved.brokerCredentialStatus });
        continue;
      }
      const credentials = await resolved.getCredentials();
      if (!credentials) {
        results.push({ user: mask(userId), engine, skipped: 'decrypt_failed' });
        continue;
      }
      const credentialBody = {
        apiKey: credentials.token,
        accountId: credentials.accountId,
        baseUrl: resolved.baseUrl,
        environment: resolved.activeEnvironment,
      };
      const reassess = await callInternalEndpoint('/api/internal/oanda/active-trades/reassess', credentialBody);
      if (!reassess.ok) {
        results.push({ user: mask(userId), engine, reassessError: reassess.error });
        continue;
      }
      const allPlans = ((reassess.data as any)?.trades ?? []) as Array<Record<string, any>>;
      const protectedPlans = allPlans.filter((plan) => pprTradeIds.has(String(plan.tradeId ?? '')));
      const trades = allPlans.filter((plan) => !pprTradeIds.has(String(plan.tradeId ?? '')));
      const userResults: Record<string, unknown>[] = [];
      reviewed += trades.length;

      for (const plan of trades) {
        const decision = shouldClose(plan, ny.afterVolatilityCutoff);
        if (!decision.close) continue;
        const closeResult = await callInternalEndpoint('/api/internal/oanda/close', {
          ...credentialBody,
          tradeId: plan.tradeId,
          instrument: plan.instrument,
          units: 'ALL',
          reason: decision.reason,
        });
        if (closeResult.ok) closed += 1;
        userResults.push({
          tradeId: plan.tradeId,
          instrument: plan.instrument,
          reason: decision.reason,
          ok: closeResult.ok,
          result: closeResult.ok ? closeResult.data : closeResult.error,
        });
      }
      results.push({
        user: mask(userId),
        engine,
        reviewed: trades.length,
        protectedPprTrades: protectedPlans.map((plan) => ({ tradeId: plan.tradeId, instrument: plan.instrument })),
        actions: userResults,
      });
    } catch (err) {
      results.push({ user: mask(userId), engine, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return NextResponse.json({ ok: true, ny, users: results.length, reviewed, closed, results });
}
