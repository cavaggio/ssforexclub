import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/db';
import { resolveActiveBrokerForUser } from '@/lib/brokerResolver';
import { callInternalEndpoint } from '@/lib/scannerProxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const mask = (id: string) => id && id.length > 6 ? `${id.slice(0, 4)}…${id.slice(-2)}` : '***';

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
    afterEntryCutoff: minutes >= 14 * 60,
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

export async function POST(req: Request) {
  const secret = process.env.AUTO_AI_CRON_SECRET;
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const ny = nyContext();
  if (ny.isWeekend || !ny.afterEntryCutoff) {
    return NextResponse.json({ ok: true, skipped: 'outside_management_window', ny });
  }

  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('user_trading_settings')
    .select('user_id')
    .eq('auto_ai_trading_enabled', true);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const results: Record<string, unknown>[] = [];
  let reviewed = 0;
  let closed = 0;

  for (const row of (data ?? []) as Array<{ user_id: string }>) {
    const userId = row.user_id;
    try {
      const resolved = await resolveActiveBrokerForUser(userId);
      if (resolved.brokerCredentialStatus !== 'ready' || !resolved.getCredentials || !resolved.baseUrl) {
        results.push({ user: mask(userId), skipped: resolved.brokerCredentialStatus });
        continue;
      }
      const credentials = await resolved.getCredentials();
      if (!credentials) {
        results.push({ user: mask(userId), skipped: 'decrypt_failed' });
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
        results.push({ user: mask(userId), reassessError: reassess.error });
        continue;
      }
      const trades = ((reassess.data as any)?.trades ?? []) as Array<Record<string, any>>;
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
      results.push({ user: mask(userId), reviewed: trades.length, actions: userResults });
    } catch (err) {
      results.push({ user: mask(userId), error: err instanceof Error ? err.message : String(err) });
    }
  }

  return NextResponse.json({ ok: true, ny, users: results.length, reviewed, closed, results });
}
