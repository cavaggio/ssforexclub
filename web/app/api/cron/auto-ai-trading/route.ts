/**
 * System cron endpoint called by the Railway staged scheduler.
 *
 * Every broker call is resolved per Clerk user and exact connected broker
 * account. Edge Intelligence is bounded to an earlier priority pre-scan only;
 * it never changes or bypasses V3 quality, alignment, confidence, R:R, news,
 * spread, sizing, margin, drawdown, duplicate, or broker gates.
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/db';
import { resolveActiveBrokerForUser } from '@/lib/brokerResolver';
import { listTradeLogsForUser, logTradeEvent } from '@/lib/tradeLogs';
import { callInternalEndpoint } from '@/lib/scannerProxy';
import { edgeSnapshotFromSignal } from '@/lib/edgeSnapshot';
import { loadAccountEdgeExecutionProfile } from '@/lib/accountEdgeExecutionProfile';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const mask = (id: string) => (
  id && id.length > 6 ? `${id.slice(0, 4)}…${id.slice(-2)}` : '***'
);

type ScanMode = 'full' | 'near_recheck' | 'hot_watch';

type CronBody = {
  runId?: unknown;
  scanMode?: unknown;
  pairs?: unknown;
};

type AutoData = {
  policyVersion?: string;
  scanned?: number;
  qualified?: number;
  executed?: unknown[];
  skipped?: unknown[];
  nearQualifiedPairs?: string[];
  hotPairs?: string[];
  lateEntryPairs?: string[];
};

function normalizeScanMode(value: unknown): ScanMode {
  const raw = String(value || 'full').toLowerCase();
  return raw === 'near_recheck' || raw === 'hot_watch' ? raw : 'full';
}

function normalizePairs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((pair) => String(pair || '').trim()).filter(Boolean);
}

function addPairs(target: Set<string>, value: unknown) {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    const pair = String(item || '').trim();
    if (pair) target.add(pair);
  }
}

function asAutoData(value: unknown): AutoData {
  return value && typeof value === 'object' ? value as AutoData : {};
}

function successfulPayload(result: Awaited<ReturnType<typeof callInternalEndpoint>>): AutoData | null {
  return result.ok ? asAutoData(result.data) : null;
}

function displayInternalResult(
  result: Awaited<ReturnType<typeof callInternalEndpoint>> | null,
  missingMessage: string,
): unknown {
  if (!result) return { error: missingMessage };
  return result.ok ? result.data : { error: result.error, status: result.status };
}

function uniqueExecuted(payloads: AutoData[]): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  const keys = new Set<string>();

  for (const payload of payloads) {
    for (const raw of payload.executed ?? []) {
      if (!raw || typeof raw !== 'object') continue;
      const executed = raw as Record<string, unknown>;
      const key = String(
        executed.tradeId ??
        `${executed.pair ?? '?'}:${executed.direction ?? '?'}:${executed.fillPrice ?? '?'}`,
      );
      if (keys.has(key)) continue;
      keys.add(key);
      output.push(executed);
    }
  }

  return output;
}

// Retains the currently deployed 02:15–11:00 ET entry window. The separate
// 2:00 PM entry/5:00 PM management change remains isolated from this correction.
function inWindow(now: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);

  const read = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  const weekday = read('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;

  const minutes =
    (parseInt(read('hour'), 10) % 24) * 60 +
    parseInt(read('minute'), 10);

  return minutes >= 135 && minutes < 660;
}

async function ictOpenTradesContext(userId: string) {
  const fallback = { rows: [] as unknown[] };
  const { rows } = await listTradeLogsForUser(userId, { limit: 50 }).catch(() => fallback);
  const output: Record<string, unknown>[] = [];

  for (const row of (rows ?? []) as Array<Record<string, unknown>>) {
    if (row.event_type !== 'opened') continue;

    const raw = (row.raw_payload ?? {}) as Record<string, unknown>;
    if (raw.strategy !== 'ICT') continue;

    const request = (raw.request ?? {}) as Record<string, unknown>;
    const result = (raw.result ?? {}) as Record<string, unknown>;

    output.push({
      tradeId: row.trade_id ?? null,
      pair: row.instrument ?? request.pair ?? null,
      direction: row.side ?? request.direction ?? null,
      entryPrice: typeof request.entry === 'number' ? request.entry : null,
      target1: typeof request.targetProfit === 'number' ? request.targetProfit : null,
      openedAtMs: Date.parse(String(row.created_at)) || null,
      holdMinutes: typeof result.holdMinutes === 'number' ? result.holdMinutes : null,
    });
  }

  return output.filter((trade) => trade.pair && trade.direction && trade.openedAtMs);
}

export async function POST(req: Request) {
  const secret = process.env.AUTO_AI_CRON_SECRET;

  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  if (!inWindow(new Date())) {
    return NextResponse.json({ ok: true, skipped: 'outside_ny_window', users: 0 });
  }

  let body: CronBody = {};
  try {
    body = await req.json() as CronBody;
  } catch {
    body = {};
  }

  let runId = typeof body.runId === 'string' ? body.runId : null;
  if (!runId) {
    runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  const scanMode = normalizeScanMode(body.scanMode);
  const pairs = normalizePairs(body.pairs);
  const tag = `[AUTO_AI][${scanMode.toUpperCase()}][runId=${runId}]`;

  if ((scanMode === 'near_recheck' || scanMode === 'hot_watch') && pairs.length === 0) {
    return NextResponse.json({ ok: true, runId, scanMode, skipped: 'no_pairs', users: 0 });
  }

  console.log(`${tag} request pairs=${pairs.length ? pairs.join(',') : 'ALL'}`);

  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('user_trading_settings')
    .select('user_id, auto_ai_engine')
    .eq('auto_ai_trading_enabled', true);

  if (error) {
    console.log(`${tag} enumerate failed: ${error.message}`);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const results: Record<string, unknown>[] = [];
  const nearQualifiedPairs = new Set<string>();
  const hotPairs = new Set<string>();
  const lateEntryPairs = new Set<string>();

  let totalQualified = 0;
  let totalExecuted = 0;
  let totalSkipped = 0;
  let totalRecommendations = 0;
  let edgePriorityUsers = 0;

  for (const row of (data ?? []) as Array<{ user_id: string; auto_ai_engine?: string }>) {
    const userId = row.user_id;
    const engine = row.auto_ai_engine === 'v3' ? 'v3' : 'ict';

    try {
      const resolved = await resolveActiveBrokerForUser(userId);

      if (
        resolved.brokerCredentialStatus !== 'ready' ||
        !resolved.getCredentials ||
        !resolved.baseUrl
      ) {
        console.log(`${tag} user=${mask(userId)} skipped=${resolved.brokerCredentialStatus}`);
        results.push({ user: mask(userId), skipped: resolved.brokerCredentialStatus });
        continue;
      }

      const credentials = await resolved.getCredentials();
      if (!credentials) {
        console.log(`${tag} user=${mask(userId)} skipped=decrypt_failed`);
        results.push({ user: mask(userId), skipped: 'decrypt_failed' });
        continue;
      }

      const accountMask = credentials.accountId
        ? `${credentials.accountId.slice(0, 3)}…${credentials.accountId.slice(-3)}`
        : '***';

      const credentialBody = {
        apiKey: credentials.token,
        accountId: credentials.accountId,
        baseUrl: resolved.baseUrl,
        environment: resolved.activeEnvironment,
        userId,
        runId,
        scanMode,
        pairs,
      };

      const edgeProfile: any = engine === 'v3'
        ? await loadAccountEdgeExecutionProfile({
            userId,
            brokerAccountId: credentials.accountId,
          })
        : {
            enabled: false,
            version: null,
            mode: 'not_applicable_to_ict',
            accountScoped: true,
            preferredPairs: [],
            reason: 'V3 account Edge priority is not applied to ICT.',
          };

      let priorityResult: Awaited<ReturnType<typeof callInternalEndpoint>> | null = null;

      if (
        engine === 'v3' &&
        scanMode === 'full' &&
        edgeProfile.enabled === true &&
        Array.isArray(edgeProfile.preferredPairs) &&
        edgeProfile.preferredPairs.length > 0
      ) {
        edgePriorityUsers += 1;
        const priorityPairs = edgeProfile.preferredPairs.slice(0, 3);

        console.log(
          `${tag} user=${mask(userId)} account=${accountMask} ` +
          `edgeProfile=${edgeProfile.version ?? 'unknown'} ` +
          `priorityPairs=${priorityPairs.join(',')} ` +
          `mode=priority_prescan_only thresholdsChanged=false`,
        );

        priorityResult = await callInternalEndpoint('/api/internal/oanda/auto', {
          ...credentialBody,
          runId: `${runId}-edge`,
          scanMode: 'near_recheck',
          pairs: priorityPairs,
          engine,
        });
      }

      const scheduledResult = await callInternalEndpoint('/api/internal/oanda/auto', {
        ...credentialBody,
        engine,
      });

      const payloads: AutoData[] = [];
      const priorityPayload = priorityResult ? successfulPayload(priorityResult) : null;
      const scheduledPayload = successfulPayload(scheduledResult);
      if (priorityPayload) payloads.push(priorityPayload);
      if (scheduledPayload) payloads.push(scheduledPayload);

      const executedList = uniqueExecuted(payloads);
      const qualified = payloads.reduce(
        (sum, payload) => sum + Number(payload.qualified ?? 0),
        0,
      );
      const skipped = payloads.reduce(
        (sum, payload) => sum + (Array.isArray(payload.skipped) ? payload.skipped.length : 0),
        0,
      );

      let reassessment: unknown = null;
      let recommendations = 0;

      if (engine === 'ict') {
        const trades = await ictOpenTradesContext(userId);
        if (trades.length) {
          const reassessResult = await callInternalEndpoint(
            '/api/internal/oanda/ict/reassess',
            { ...credentialBody, trades },
          );
          reassessment = displayInternalResult(reassessResult, 'reassessment missing');

          if (reassessResult.ok) {
            const recommendationList =
              (reassessResult.data as {
                recommendations?: Array<{ reassessDue?: boolean }>;
              })?.recommendations ?? [];
            recommendations = recommendationList.filter((item) => item?.reassessDue).length;
          }
        }
      }

      totalQualified += qualified;
      totalExecuted += executedList.length;
      totalSkipped += skipped;
      totalRecommendations += recommendations;

      for (const executed of executedList) {
        const signal = executed.signal && typeof executed.signal === 'object'
          ? executed.signal as Record<string, unknown>
          : executed;

        await logTradeEvent({
          userId,
          broker: (resolved.activeBroker ?? 'oanda') as 'oanda',
          brokerAccountId: credentials.accountId,
          environment: resolved.activeEnvironment as 'practice' | 'live' | 'paper',
          eventType: 'opened',
          instrument: typeof executed.pair === 'string' ? executed.pair : null,
          tradeId: typeof executed.tradeId === 'string' ? executed.tradeId : null,
          brokerOrderId: typeof executed.tradeId === 'string' ? executed.tradeId : null,
          side:
            executed.direction === 'long' || executed.direction === 'short'
              ? executed.direction
              : null,
          units: typeof executed.units === 'number' ? Math.abs(executed.units) : null,
          entryPrice: typeof executed.fillPrice === 'number' ? executed.fillPrice : null,
          sl: typeof executed.stopLoss === 'number' ? executed.stopLoss : null,
          tp: typeof executed.takeProfit === 'number' ? executed.takeProfit : null,
          confidence: typeof executed.confidence === 'number' ? executed.confidence : null,
          recommendation:
            typeof executed.expectedRR === 'number'
              ? `RR ${executed.expectedRR}`
              : 'V3_AUTO',
          reason: `Auto AI ${engine.toUpperCase()} opened trade during run ${runId}`,
          rawPayload: {
            runId,
            scanMode,
            engine,
            brokerAccountId: credentials.accountId,
            edgeProfile: {
              version: edgeProfile.version ?? null,
              enabled: edgeProfile.enabled === true,
              mode: edgeProfile.mode ?? null,
              accountScoped: edgeProfile.accountScoped === true,
              preferredPairs: Array.isArray(edgeProfile.preferredPairs)
                ? edgeProfile.preferredPairs
                : [],
              thresholdsChanged: false,
            },
            executed,
          },
          edge: edgeSnapshotFromSignal(signal),
        });
      }

      for (const payload of payloads) {
        addPairs(nearQualifiedPairs, payload.nearQualifiedPairs);
        addPairs(hotPairs, payload.hotPairs);
        addPairs(lateEntryPairs, payload.lateEntryPairs);
      }

      console.log(
        `${tag} user=${mask(userId)} account=${accountMask} engine=${engine} ` +
        `scanMode=${scanMode} qualified=${qualified} executed=${executedList.length} ` +
        `skipped=${skipped} recommendations=${recommendations} ` +
        `edgePriority=${edgeProfile.enabled === true} ` +
        `policy=${scheduledPayload?.policyVersion ?? priorityPayload?.policyVersion ?? 'unknown'}`,
      );

      results.push({
        user: mask(userId),
        account: accountMask,
        engine,
        edgeProfile,
        priorityScan: displayInternalResult(priorityResult, 'priority scan not used'),
        auto: displayInternalResult(scheduledResult, 'scheduled scan missing'),
        reassessment,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`${tag} user=${mask(userId)} error=${message}`);
      results.push({ user: mask(userId), error: message });
    }
  }

  const nearList = Array.from(nearQualifiedPairs);
  const hotList = Array.from(hotPairs);
  const lateList = Array.from(lateEntryPairs);

  console.log(
    `${tag} complete users=${results.length} qualified=${totalQualified} ` +
    `executed=${totalExecuted} skipped=${totalSkipped} ` +
    `recommendations=${totalRecommendations} edgePriorityUsers=${edgePriorityUsers} ` +
    `near=${nearList.length} hot=${hotList.length} late=${lateList.length}`,
  );

  return NextResponse.json({
    ok: true,
    runId,
    scanMode,
    pairs,
    users: results.length,
    qualified: totalQualified,
    executed: totalExecuted,
    skipped: totalSkipped,
    recommendations: totalRecommendations,
    edgePriorityUsers,
    edgeLearningMode: 'per_user_per_broker_account_priority_prescan_only',
    edgeThresholdsChanged: false,
    nearQualifiedPairs: nearList,
    hotPairs: hotList,
    lateEntryPairs: lateList,
    results,
  });
}
