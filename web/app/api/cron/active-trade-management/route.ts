import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/db';
import { resolveActiveBrokerForUser } from '@/lib/brokerResolver';
import { callInternalEndpoint } from '@/lib/scannerProxy';
import { listTradeLogsForUser, logTradeEvent } from '@/lib/tradeLogs';
import { evaluateActiveExit, closeUnitsForDecision } from '@/lib/activeExitPolicy.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const mask = (id: string) => id && id.length > 6 ? `${id.slice(0, 4)}…${id.slice(-2)}` : '***';

type AutoAiEngine = 'ict' | 'v3' | 'ppr';
type ExitState = {
  partial_count?: number | null;
  cumulative_partial_percent?: number | null;
  peak_profit_r?: number | null;
  peak_profit_pips?: number | null;
  last_action?: string | null;
  last_action_at?: string | null;
};
type ManagementDecision = {
  action: 'HOLD_TO_TP' | 'PARTIAL_CLOSE' | 'FULL_CLOSE';
  closePercent: number;
  reason: string;
  confidence: number;
  policy: string;
  metrics?: Record<string, any>;
  evidence?: string[];
};

const ACTION_COOLDOWN_MS = 4 * 60 * 1000;

function normalizeEngine(value: unknown): AutoAiEngine {
  if (value === 'v3' || value === 'ppr') return value;
  return 'ict';
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isMissingAutoCloseSchema(error: { code?: string; message?: string } | null | undefined) {
  const message = String(error?.message || '');
  return error?.code === '42703' || error?.code === '42P01' ||
    /auto_close_enabled|trade_exit_management_state|does not exist/i.test(message);
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
    managementStarted: minutes >= 2 * 60 + 15,
    beforeManagementEnd: minutes < 17 * 60 + 30,
    afterVolatilityCutoff: minutes >= 17 * 60,
  };
}

function v3ExitDecision(plan: Record<string, any>, afterVolatilityCutoff: boolean): ManagementDecision {
  const reversalRisk = String(
    plan.reversalRisk ?? plan.detail?.invalidation?.reversalRisk ??
    plan.detail?.trendWeakening?.severity ?? plan.trendWeakeningSeverity ?? '',
  ).toLowerCase();
  const momentum = String(plan.momentumStatus ?? '').toLowerCase();
  const action = String(plan.recommendedAction ?? '').toUpperCase();
  const lifecycleAction = String(plan.lifecycleRecommendation?.action ?? '').toLowerCase();
  const profitR = finiteNumber(plan.profitRMultiple) ?? 0;

  if (lifecycleAction === 'partial_close' && profitR > 0) {
    const requested = finiteNumber(
      plan.partialExitPercent ?? plan.partialClose?.recommendedPartialClosePercent,
    ) ?? 25;
    return {
      action: 'PARTIAL_CLOSE',
      closePercent: Math.max(25, Math.min(50, Math.round(requested))),
      reason: plan.lifecycleRecommendation?.reason || 'V3 lifecycle recommends protecting a profitable position with a partial exit.',
      confidence: finiteNumber(plan.lifecycleRecommendation?.confidence) ?? 75,
      policy: 'v3_existing_active_management',
    };
  }

  const mediumOrHigherReversal = reversalRisk === 'medium' || reversalRisk === 'high' ||
    momentum.includes('reversal') || momentum.includes('reversed');
  const immediateExit = plan.invalidationDetected === true ||
    action === 'EXIT_INVALIDATED' || action === 'EXIT_REVIEW' ||
    lifecycleAction.includes('exit') || lifecycleAction.includes('close') ||
    mediumOrHigherReversal;
  const slowedByFive = afterVolatilityCutoff && (
    plan.volatilityCollapsed === true || momentum.includes('decay') ||
    momentum.includes('slowing') || plan.trendWeakeningDetected === true
  );

  if (immediateExit || slowedByFive) {
    return {
      action: 'FULL_CLOSE',
      closePercent: 100,
      reason: immediateExit
        ? 'V3 invalidation or medium/high reversal risk requires an active exit.'
        : 'Late-session volatility or momentum deterioration requires an active exit.',
      confidence: immediateExit ? 84 : 72,
      policy: 'v3_existing_active_management',
    };
  }

  return {
    action: 'HOLD_TO_TP',
    closePercent: 0,
    reason: 'V3 thesis remains active; hold the original take profit.',
    confidence: 70,
    policy: 'v3_existing_active_management',
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

async function openTradeStrategies(userId: string): Promise<Map<string, AutoAiEngine>> {
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

  const strategies = new Map<string, AutoAiEngine>();
  for (const [tradeId, row] of latestByTrade) {
    if (row.event_type !== 'opened') continue;
    const strategy = eventStrategy(row);
    if (strategy === 'ict' || strategy === 'v3' || strategy === 'ppr') {
      strategies.set(tradeId, strategy);
    }
  }
  return strategies;
}

async function loadExitStates(
  supabase: ReturnType<typeof getServerSupabase>,
  userId: string,
  accountId: string,
  tradeIds: string[],
): Promise<Map<string, ExitState>> {
  if (!tradeIds.length) return new Map();
  const { data, error } = await supabase
    .from('trade_exit_management_state')
    .select('trade_id, partial_count, cumulative_partial_percent, peak_profit_r, peak_profit_pips, last_action, last_action_at')
    .eq('user_id', userId)
    .eq('broker_account_id', accountId)
    .in('trade_id', tradeIds);
  if (error) throw error;
  return new Map((data ?? []).map((row: Record<string, any>) => [String(row.trade_id), row]));
}

async function saveExitState(args: {
  supabase: ReturnType<typeof getServerSupabase>;
  userId: string;
  accountId: string;
  tradeId: string;
  instrument: string;
  engine: AutoAiEngine;
  state: ExitState;
  decision: ManagementDecision;
  action?: string | null;
  actionAt?: string | null;
}) {
  const currentPeakR = finiteNumber(args.decision.metrics?.peakProfitR);
  const currentPeakPips = finiteNumber(args.decision.metrics?.peakProfitPips);
  const row = {
    user_id: args.userId,
    broker_account_id: args.accountId,
    trade_id: args.tradeId,
    instrument: args.instrument,
    engine: args.engine,
    partial_count: Math.max(0, Number(args.state.partial_count || 0)),
    cumulative_partial_percent: Math.max(0, Number(args.state.cumulative_partial_percent || 0)),
    peak_profit_r: currentPeakR ?? args.state.peak_profit_r ?? null,
    peak_profit_pips: currentPeakPips ?? args.state.peak_profit_pips ?? null,
    last_action: args.action ?? args.state.last_action ?? null,
    last_action_at: args.actionAt ?? args.state.last_action_at ?? null,
    last_decision: args.decision,
    updated_at: new Date().toISOString(),
  };
  const { error } = await args.supabase
    .from('trade_exit_management_state')
    .upsert(row, { onConflict: 'user_id,broker_account_id,trade_id' });
  if (error) throw error;
}

function recentAction(state: ExitState): boolean {
  const at = Date.parse(String(state.last_action_at || ''));
  return Number.isFinite(at) && Date.now() - at < ACTION_COOLDOWN_MS;
}

function logEnvironment(value: unknown): 'practice' | 'live' | 'paper' {
  if (value === 'live') return 'live';
  if (value === 'paper') return 'paper';
  return 'practice';
}

export async function POST(req: Request) {
  const secret = process.env.AUTO_AI_CRON_SECRET;
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const ny = nyContext();
  if (ny.isWeekend || !ny.managementStarted || !ny.beforeManagementEnd) {
    return NextResponse.json({ ok: true, skipped: 'outside_management_window_02:15-17:30_ET', ny });
  }

  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('user_trading_settings')
    .select('user_id, auto_ai_engine, auto_close_enabled')
    .eq('auto_close_enabled', true);

  if (error) {
    if (isMissingAutoCloseSchema(error)) {
      return NextResponse.json({ ok: true, skipped: 'active_exit_intelligence_migration_required', ny });
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const results: Record<string, unknown>[] = [];
  let reviewed = 0;
  let closed = 0;
  let partials = 0;

  for (const row of (data ?? []) as Array<{ user_id: string; auto_ai_engine?: string }>) {
    const userId = row.user_id;
    const selectedEngine = normalizeEngine(row.auto_ai_engine);

    try {
      const tradeStrategies = await openTradeStrategies(userId);
      const resolved = await resolveActiveBrokerForUser(userId);
      if (resolved.brokerCredentialStatus !== 'ready' || !resolved.getCredentials || !resolved.baseUrl) {
        results.push({ user: mask(userId), engine: selectedEngine, skipped: resolved.brokerCredentialStatus });
        continue;
      }
      const credentials = await resolved.getCredentials();
      if (!credentials) {
        results.push({ user: mask(userId), engine: selectedEngine, skipped: 'decrypt_failed' });
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
        results.push({ user: mask(userId), engine: selectedEngine, reassessError: reassess.error });
        continue;
      }

      const allPlans = ((reassess.data as any)?.trades ?? []) as Array<Record<string, any>>;
      const tradeIds = allPlans.map((plan) => String(plan.tradeId ?? '')).filter(Boolean);
      let stateByTrade: Map<string, ExitState>;
      try {
        stateByTrade = await loadExitStates(supabase, userId, credentials.accountId, tradeIds);
      } catch (stateError) {
        if (isMissingAutoCloseSchema(stateError as { code?: string; message?: string })) {
          results.push({ user: mask(userId), skipped: 'active_exit_state_migration_required' });
          continue;
        }
        throw stateError;
      }

      const userResults: Record<string, unknown>[] = [];
      const evaluations: Record<string, unknown>[] = [];
      reviewed += allPlans.length;

      for (const plan of allPlans) {
        const tradeId = String(plan.tradeId ?? '');
        if (!tradeId) continue;
        const tradeEngine = tradeStrategies.get(tradeId) ?? selectedEngine;
        if (tradeEngine === 'ppr') {
          evaluations.push({ tradeId, instrument: plan.instrument, engine: tradeEngine, skipped: 'ppr_sl_tp_only' });
          continue;
        }

        const previousState = stateByTrade.get(tradeId) ?? {};
        const decision = (tradeEngine === 'ict'
          ? evaluateActiveExit(plan, {
              priorPartialCount: previousState.partial_count ?? 0,
              peakProfitR: previousState.peak_profit_r ?? null,
              peakProfitPips: previousState.peak_profit_pips ?? null,
            })
          : v3ExitDecision(plan, ny.afterVolatilityCutoff)) as ManagementDecision;

        evaluations.push({
          tradeId,
          instrument: plan.instrument,
          engine: tradeEngine,
          action: decision.action,
          closePercent: decision.closePercent,
          policy: decision.policy,
          reason: decision.reason,
          confidence: decision.confidence,
          metrics: decision.metrics,
        });

        if (decision.action === 'HOLD_TO_TP') {
          await saveExitState({
            supabase, userId, accountId: credentials.accountId, tradeId,
            instrument: String(plan.instrument ?? ''), engine: tradeEngine,
            state: previousState, decision,
          });
          continue;
        }

        if (recentAction(previousState)) {
          evaluations.push({ tradeId, skipped: 'exit_action_cooldown', lastAction: previousState.last_action });
          continue;
        }

        const units = closeUnitsForDecision(plan.units, decision);
        if (units == null) {
          evaluations.push({ tradeId, skipped: 'partial_units_unavailable', currentUnits: plan.units ?? null });
          continue;
        }

        const actionAt = new Date().toISOString();
        await saveExitState({
          supabase, userId, accountId: credentials.accountId, tradeId,
          instrument: String(plan.instrument ?? ''), engine: tradeEngine,
          state: previousState, decision,
          action: `PENDING_${decision.action}`,
          actionAt,
        });

        const closeResult = await callInternalEndpoint('/api/internal/oanda/close', {
          ...credentialBody,
          tradeId,
          instrument: plan.instrument,
          units,
          reason: `${decision.policy}:${decision.reason}`,
        });

        const nextState: ExitState = { ...previousState };
        if (closeResult.ok && decision.action === 'PARTIAL_CLOSE') {
          nextState.partial_count = Number(previousState.partial_count || 0) + 1;
          nextState.cumulative_partial_percent = Math.min(
            100,
            Number(previousState.cumulative_partial_percent || 0) + decision.closePercent,
          );
          partials += 1;
        }
        if (closeResult.ok && decision.action === 'FULL_CLOSE') closed += 1;

        await saveExitState({
          supabase, userId, accountId: credentials.accountId, tradeId,
          instrument: String(plan.instrument ?? ''), engine: tradeEngine,
          state: nextState, decision,
          action: closeResult.ok ? decision.action : `FAILED_${decision.action}`,
          actionAt,
        });

        if (closeResult.ok) {
          await logTradeEvent({
            userId,
            broker: 'oanda',
            brokerAccountId: credentials.accountId,
            environment: logEnvironment(resolved.activeEnvironment),
            eventType: decision.action === 'PARTIAL_CLOSE' ? 'partial_closed' : 'closed',
            instrument: String(plan.instrument ?? ''),
            tradeId,
            side: plan.direction === 'short' ? 'short' : 'long',
            units: finiteNumber(plan.units),
            unitsClosed: units === 'ALL' ? finiteNumber(plan.units) : finiteNumber(units),
            unrealizedPL: finiteNumber(plan.currentPnL),
            recommendation: decision.action,
            confidence: decision.confidence,
            reason: decision.reason,
            rawPayload: { policy: decision.policy, decision, closeResult: closeResult.data },
          });
        }

        userResults.push({
          tradeId,
          instrument: plan.instrument,
          engine: tradeEngine,
          action: decision.action,
          closePercent: decision.closePercent,
          units,
          policy: decision.policy,
          reason: decision.reason,
          ok: closeResult.ok,
          result: closeResult.ok ? closeResult.data : closeResult.error,
        });
      }

      results.push({
        user: mask(userId),
        engine: selectedEngine,
        reviewed: allPlans.length,
        actions: userResults,
        evaluations,
      });
    } catch (err) {
      results.push({ user: mask(userId), engine: selectedEngine, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return NextResponse.json({
    ok: true,
    ny,
    users: results.length,
    reviewed,
    closed,
    partials,
    autoCloseToggle: 'user_trading_settings.auto_close_enabled',
    ictClosePolicy: 'active_exit_intelligence_v1',
    results,
  });
}
