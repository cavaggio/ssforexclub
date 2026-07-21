import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/db';
import { resolveActiveBrokerForUser } from '@/lib/brokerResolver';
import { callInternalEndpoint } from '@/lib/scannerProxy';
import { listTradeLogsForUser } from '@/lib/tradeLogs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const mask = (id: string) => id && id.length > 6 ? `${id.slice(0, 4)}…${id.slice(-2)}` : '***';

type AutoAiEngine = 'ict' | 'v3' | 'ppr';
type CloseDecision = {
  close: boolean;
  reason: string | null;
  policy: string;
  details?: Record<string, unknown>;
};

const ICT_MIN_REASSESSMENT_AGE_MINUTES = 30;
const ICT_NEAR_SL_RISK_FRACTION = 0.25;
const ICT_NEAR_SL_MIN_PIPS = 2;

function normalizeEngine(value: unknown): AutoAiEngine {
  if (value === 'v3' || value === 'ppr') return value;
  return 'ict';
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

/**
 * ICT positions are intentionally protected from scanner/requalification exits.
 * An ICT broker close is permitted only when ALL of these are true:
 *   1. The position has been open for at least 30 minutes.
 *   2. The active-trade reassessment reports HIGH reversal/invalidation risk.
 *   3. The reassessment explicitly recommends CLOSE/EXIT, not merely REVIEW.
 *   4. Price is within the final 25% of the original stop distance (minimum 2 pips).
 */
function shouldCloseIctTrade(plan: Record<string, any>): CloseDecision {
  const minutesElapsed = finiteNumber(plan.minutesElapsed) ?? 0;
  const reassessmentDue = minutesElapsed >= ICT_MIN_REASSESSMENT_AGE_MINUTES;

  const reversalRisk = String(
    plan.reversalRisk ??
    plan.detail?.invalidation?.reversalRisk ??
    '',
  ).toLowerCase();
  const invalidationSeverity = String(plan.invalidationSeverity ?? '').toLowerCase();
  const trendWeakeningSeverity = String(plan.trendWeakeningSeverity ?? '').toLowerCase();
  const momentum = String(plan.momentumStatus ?? '').toLowerCase();
  const lifecycleAction = String(plan.lifecycleRecommendation?.action ?? '').toUpperCase();
  const lifecycleUrgency = String(plan.lifecycleRecommendation?.urgency ?? '').toLowerCase();
  const lifecycleSource = String(plan.lifecycleRecommendation?.source ?? '').toLowerCase();
  const recommendedAction = String(plan.recommendedAction ?? '').toUpperCase();

  const explicitHighReversal =
    reversalRisk === 'high' ||
    (plan.invalidationDetected === true && invalidationSeverity === 'high') ||
    (
      lifecycleUrgency === 'high' &&
      (lifecycleSource === 'thesis_invalidation' || lifecycleSource === 'institutional_reversal')
    ) ||
    (
      plan.trendWeakeningDetected === true &&
      trendWeakeningSeverity === 'high' &&
      plan.institutionalFlow?.opposes === true &&
      (momentum.includes('reversal') || momentum.includes('reversed'))
    );

  const explicitCloseRecommendation =
    plan.invalidationDetected === true ||
    recommendedAction === 'EXIT_INVALIDATED' ||
    lifecycleAction === 'CLOSE' ||
    lifecycleAction === 'EXIT' ||
    lifecycleAction === 'EXIT_NOW';

  const distanceToSL = finiteNumber(plan.distanceToSL);
  const initialRiskPips = finiteNumber(
    plan.initialRiskPips ??
    plan.originalRiskPips ??
    plan.detail?.lifecycle?.originalSlPips,
  );
  const nearSlThresholdPips = initialRiskPips != null && initialRiskPips > 0
    ? Math.max(ICT_NEAR_SL_MIN_PIPS, initialRiskPips * ICT_NEAR_SL_RISK_FRACTION)
    : null;
  const closeToStop =
    distanceToSL != null &&
    distanceToSL >= 0 &&
    nearSlThresholdPips != null &&
    distanceToSL <= nearSlThresholdPips;

  const close = Boolean(
    reassessmentDue &&
    explicitHighReversal &&
    explicitCloseRecommendation &&
    closeToStop,
  );

  return {
    close,
    reason: close ? 'ict_30m_high_reversal_near_sl' : null,
    policy: 'ict_30m_high_reversal_near_sl_only',
    details: {
      minutesElapsed,
      reassessmentDue,
      explicitHighReversal,
      explicitCloseRecommendation,
      closeToStop,
      distanceToSL,
      initialRiskPips,
      nearSlThresholdPips,
      reversalRisk: reversalRisk || null,
      invalidationSeverity: invalidationSeverity || null,
      lifecycleAction: lifecycleAction || null,
      lifecycleUrgency: lifecycleUrgency || null,
      lifecycleSource: lifecycleSource || null,
    },
  };
}

// Preserve the existing V3 management policy. ICT never uses this function.
function shouldCloseV3Trade(plan: Record<string, any>, afterVolatilityCutoff: boolean): CloseDecision {
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
    const selectedEngine = normalizeEngine(row.auto_ai_engine);

    try {
      const tradeStrategies = await openTradeStrategies(userId);

      if (selectedEngine === 'ppr') {
        results.push({
          user: mask(userId),
          engine: selectedEngine,
          skipped: 'ppr_native_management_not_configured_sl_tp_only',
        });
        continue;
      }

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
      const userResults: Record<string, unknown>[] = [];
      const evaluations: Record<string, unknown>[] = [];
      reviewed += allPlans.length;

      for (const plan of allPlans) {
        const tradeId = String(plan.tradeId ?? '');
        const tradeEngine = tradeStrategies.get(tradeId) ?? selectedEngine;

        if (tradeEngine === 'ppr') {
          evaluations.push({ tradeId, instrument: plan.instrument, engine: tradeEngine, skipped: 'ppr_sl_tp_only' });
          continue;
        }

        const decision = tradeEngine === 'ict'
          ? shouldCloseIctTrade(plan)
          : shouldCloseV3Trade(plan, ny.afterVolatilityCutoff);

        evaluations.push({
          tradeId,
          instrument: plan.instrument,
          engine: tradeEngine,
          close: decision.close,
          policy: decision.policy,
          reason: decision.reason,
          details: decision.details,
        });

        if (tradeEngine === 'ict') {
          console.log(
            `[ACTIVE_TRADE_MANAGEMENT][ICT] tradeId=${tradeId} pair=${plan.instrument} ` +
            `close=${decision.close} ${JSON.stringify(decision.details ?? {})}`,
          );
        }

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
          engine: tradeEngine,
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
    ictClosePolicy: '30m_high_reversal_near_sl_only',
    results,
  });
}
