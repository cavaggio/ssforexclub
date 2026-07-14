/**
 * web/app/api/cron/auto-ai-trading/route.ts
 *
 * System cron endpoint (NO Clerk session) called by the Railway staged
 * scheduler. Per opted-in user it resolves credentials on the Next side and
 * forwards to the Railway internal Auto AI endpoint — autonomous entry
 * (/api/internal/oanda/auto) plus recommend-only ICT lifecycle reassessment.
 *
 * Auth: shared X-Cron-Secret (AUTO_AI_CRON_SECRET). Gates: platform live flag +
 * NY weekday entry window + per-user (ready, live) resolution. Never falls back
 * to platform-default credentials.
 *
 * Edge Intelligence influence is deliberately bounded and account-scoped:
 * proven positive pairs may receive an earlier priority pre-scan, but no V3
 * quality, alignment, confidence, R:R, news, spread, sizing, margin, drawdown,
 * duplicate, or broker gate is changed or bypassed.
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

const mask = (id: string) => (id && id.length > 6 ? `${id.slice(0, 4)}…${id.slice(-2)}` : '***');

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

  return value
    .map((p) => String(p || '').trim())
    .filter(Boolean);
}

function addPairs(target: Set<string>, value: unknown) {
  if (!Array.isArray(value)) return;

  for (const item of value) {
    const pair = String(item || '').trim();
    if (pair) target.add(pair);
  }
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

// NY weekday entry window (DST-aware; Railway performs the same defense).
function inWindow(now: Date): boolean {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);

  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  const wd = get('weekday');

  if (wd === 'Sat' || wd === 'Sun') return false;

  const mins = (parseInt(get('hour'), 10) % 24) * 60 + parseInt(get('minute'), 10);
  // This route retains the currently deployed window. The separately prepared
  // 2:00 PM extension must be merged as its own deployment change.
  return mins >= 135 && mins < 660;
}

// Build the reassessment context from a user's recent ICT 'opened' trade logs.
async function ictOpenTradesContext(userId: string) {
  const { rows } = await listTradeLogsForUser(userId, { limit: 50 }).catch(() => ({ rows: [] as unknown[] }));
  const out: Record<string, unknown>[] = [];
  for (const r of (rows ?? []) as Array<Record<string, unknown>>) {
    if (r.event_type !== 'opened') continue;
    const raw = (r.raw_payload ?? {}) as Record<string, unknown>;
    if (raw.strategy !== 'ICT') continue;
    const req = (raw.request ?? {}) as Record<string, unknown>;
    const result = (raw.result ?? {}) as Record<string, unknown>;
    out.push({
      tradeId: r.trade_id ?? null,
      pair: r.instrument ?? req.pair ?? null,
      direction: r.side ?? req.direction ?? null,
      entryPrice: typeof req.entry === 'number' ? req.entry : null,
      target1: typeof req.targetProfit === 'number' ? req.targetProfit : null,
      openedAtMs: Date.parse(String(r.created_at)) || null,
      holdMinutes: typeof result.holdMinutes === 'number' ? result.holdMinutes : null,
    });
  }
  return out.filter((t) => t.pair && t.direction && t.openedAtMs);
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
    body = (await req.json()) as CronBody;
  } catch {
    body = {};
  }

  let runId: string | null = typeof body?.runId === 'string' ? body.runId : null;
  if (!runId) runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const scanMode = normalizeScanMode(body?.scanMode);
  const pairs = normalizePairs(body?.pairs);
  const tag = `[AUTO_AI][${scanMode.toUpperCase()}][runId=${runId}]`;

  if ((scanMode === 'near_recheck' || scanMode === 'hot_watch') && !pairs.length) {
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
  let totalRecs = 0;
  let edgePriorityUsers = 0;

  for (const row of (data ?? []) as Array<{ user_id: string; auto_ai_engine?: string }>) {
    const userId = row.user_id;
    const engine = row.auto_ai_engine === 'v3' ? 'v3' : 'ict';

    try {
      const resolved = await resolveActiveBrokerForUser(userId);
      if (resolved.brokerCredentialStatus !== 'ready' || !resolved.getCredentials || !resolved.baseUrl) {
        console.log(`${tag} user=${mask(userId)} skipped=${resolved.brokerCredentialStatus}`);
        results.push({ user: mask(userId), skipped: resolved.brokerCredentialStatus });
        continue;
      }

      const creds = await resolved.getCredentials();
      if (!creds) {
        console.log(`${tag} user=${mask(userId)} skipped=decrypt_failed`);
        results.push({ user: mask(userId), skipped: 'decrypt_failed' });
        continue;
      }

      const acct = creds.accountId ? `${creds.accountId.slice(0, 3)}…${creds.accountId.slice(-3)}` : '***';
      const credBody = {
        apiKey: creds.token,
        accountId: creds.accountId,
        baseUrl: resolved.baseUrl,
        environment: resolved.activeEnvironment,
        runId,
        scanMode,
        pairs,
      };

      const edgeProfile = engine === 'v3'
        ? await loadAccountEdgeExecutionProfile({
            userId,
            brokerAccountId: creds.accountId,
          })
        : {
            enabled: false,
            mode: 'not_applicable_to_ict',
            accountScoped: true,
            preferredPairs: [] as string[],
            reason: 'V3 account Edge priority is not applied to ICT.',
          };

      const autoCalls: Array<{
        kind: 'edge_priority' | 'scheduled';
        result: Awaited<ReturnType<typeof callInternalEndpoint>>;
      }> = [];

      // A full V3 cycle may pre-scan up to three proven positive pairs for this
      // exact user + broker account. The normal full scan still runs afterward,
      // so no watchlist coverage is lost and no pair is permanently excluded.
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
          `${tag} user=${mask(userId)} account=${acct} ` +
          `edgeProfile=${edgeProfile.version} priorityPairs=${priorityPairs.join(',')} ` +
          `mode=priority_prescan_only thresholdsChanged=false`,
        );

        const priorityResult = await callInternalEndpoint('/api/internal/oanda/auto', {
          ...credBody,
          runId: `${runId}-edge`,
          scanMode: 'near_recheck',
          pairs: priorityPairs,
          engine,
        });
        autoCalls.push({ kind: 'edge_priority', result: priorityResult });
      }

      const scheduledResult = await callInternalEndpoint('/api/internal/oanda/auto', {
        ...credBody,
        engine,
      });
      autoCalls.push({ kind: 'scheduled', result: scheduledResult });

      const autoPayloads = autoCalls
        .filter((call) => call.result.ok)
        .map((call) => call.result.data as AutoData);

      const executedList = uniqueExecuted(autoPayloads);
      const q = autoPayloads.reduce((sum, payload) => sum + Number(payload.qualified ?? 0), 0);
      const s = autoPayloads.reduce(
        (sum, payload) => sum + (Array.isArray(payload.skipped) ? payload.skipped.length : 0),
        0,
      );
      const e = executedList.length;

      let reassess: unknown = null;
      let recs = 0;
      if (engine === 'ict') {
        const trades = await ictOpenTradesContext(userId);
        if (trades.length) {
          const r = await callInternalEndpoint('/api/internal/oanda/ict/reassess', { ...credBody, trades });
          reassess = r.ok ? r.data : { error: r.error };
          const recList = (r.ok
            ? (r.data as { recommendations?: Array<{ reassessDue?: boolean }> })?.recommendations
            : null) ?? [];
          recs = recList.filter((x) => x?.reassessDue).length;
        }
      }

      totalQualified += q;
      totalExecuted += e;
      totalSkipped += s;
      totalRecs += recs;

      for (const executed of executedList) {
        const sig = (executed.signal && typeof executed.signal === 'object')
          ? executed.signal as Record<string, unknown>
          : executed;

        await logTradeEvent({
          userId,
          broker: (resolved.activeBroker ?? 'oanda') as 'oanda',
          brokerAccountId: creds.accountId,
          environment: resolved.activeEnvironment as 'practice' | 'live' | 'paper',
          eventType: 'opened',
          instrument: typeof executed.pair === 'string' ? executed.pair : null,
          tradeId: typeof executed.tradeId === 'string' ? executed.tradeId : null,
          brokerOrderId: typeof executed.tradeId === 'string' ? executed.tradeId : null,
          side: executed.direction === 'long' || executed.direction === 'short' ? executed.direction : null,
          units: typeof executed.units === 'number' ? Math.abs(executed.units) : null,
          entryPrice: typeof executed.fillPrice === 'number' ? executed.fillPrice : null,
          sl: typeof executed.stopLoss === 'number' ? executed.stopLoss : null,
          tp: typeof executed.takeProfit === 'number' ? executed.takeProfit : null,
          confidence: typeof executed.confidence === 'number' ? executed.confidence : null,
          recommendation: typeof executed.expectedRR === 'number' ? `RR ${executed.expectedRR}` : 'V3_AUTO',
          reason: `Auto AI ${engine.toUpperCase()} opened trade during run ${runId}`,
          rawPayload: {
            runId,
            scanMode,
            engine,
            brokerAccountId: creds.accountId,
            edgeProfile: {
              version: edgeProfile.version,
              enabled: edgeProfile.enabled,
              mode: edgeProfile.mode,
              accountScoped: edgeProfile.accountScoped,
              preferredPairs: edgeProfile.preferredPairs,
              thresholdsChanged: false,
            },
            executed,
          },
          edge: edgeSnapshotFromSignal(sig),
        });
      }

      for (const payload of autoPayloads) {
        addPairs(nearQualifiedPairs, payload.nearQualifiedPairs);
        addPairs(hotPairs, payload.hotPairs);
        addPairs(lateEntryPairs, payload.lateEntryPairs);
      }

      const scheduledCall = autoCalls.find((call) => call.kind === 'scheduled');
      const priorityCall = autoCalls.find((call) => call.kind === 'edge_priority');

      console.log(
        `${tag} user=${mask(userId)} account=${acct} engine=${engine} scanMode=${scanMode} ` +
        `qualified=${q} executed=${e} skipped=${s} recommendations=${recs} ` +
        `edgePriority=${edgeProfile.enabled === true} policy=${autoPayloads[0]?.policyVersion ?? 'unknown'}`,
      );

      results.push({
        user: mask(userId),
        account: acct,
        engine,
        edgeProfile,
        priorityScan: priorityCall
          ? priorityCall.result.ok
            ? priorityCall.result.data
            : { error: priorityCall.result.error }
          : null,
        auto: scheduledCall?.result.ok
          ? scheduledCall.result.data
          : { error: scheduledCall?.result.error ?? 'scheduled auto call missing' },
        reassess,
      });
    } catch (err) {
      console.log(`${tag} user=${mask(userId)} error=${err instanceof Error ? err.message : String(err)}`);
      results.push({ user: mask(userId), error: err instanceof Error ? err.message : String(err) });
    }
  }

  const nearQualifiedPairList = Array.from(nearQualifiedPairs);
  const hotPairList = Array.from(hotPairs);
  const lateEntryPairList = Array.from(lateEntryPairs);

  console.log(
    `${tag} complete users=${results.length} qualified=${totalQualified} executed=${totalExecuted} ` +
    `skipped=${totalSkipped} recommendations=${totalRecs} edgePriorityUsers=${edgePriorityUsers} ` +
    `near=${nearQualifiedPairList.length} hot=${hotPairList.length} late=${lateEntryPairList.length}`,
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
    recommendations: totalRecs,
    edgePriorityUsers,
    edgeLearningMode: 'per_user_per_broker_account_priority_prescan_only',
    edgeThresholdsChanged: false,
    nearQualifiedPairs: nearQualifiedPairList,
    hotPairs: hotPairList,
    lateEntryPairs: lateEntryPairList,
    results,
  });
}
