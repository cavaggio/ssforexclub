/**
 * web/app/api/cron/auto-ai-trading/route.ts
 *
 * System cron endpoint (NO Clerk session) called by the Railway staged
 * scheduler. Per opted-in user it resolves credentials on the Next side and
 * forwards to the Railway internal Auto AI endpoint — autonomous entry
 * (/api/internal/oanda/auto) plus recommend-only ICT lifecycle reassessment.
 *
 * Auth: shared X-Cron-Secret (AUTO_AI_CRON_SECRET). Gates: platform live flag +
 * NY weekday 02:15–14:00 ET window + per-user (ready, live) resolution. Never
 * falls back to platform-default creds.
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/db';
import { resolveActiveBrokerForUser } from '@/lib/brokerResolver';
import { listTradeLogsForUser } from '@/lib/tradeLogs';
import { callInternalEndpoint } from '@/lib/scannerProxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const mask = (id: string) => (id && id.length > 6 ? `${id.slice(0, 4)}…${id.slice(-2)}` : '***');

type ScanMode = 'full' | 'near_recheck' | 'hot_watch';

type CronBody = {
  runId?: unknown;
  scanMode?: unknown;
  pairs?: unknown;
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

// NY weekday 02:15–14:00 ET (DST-aware, defense in depth — the Railway loop also checks).
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
  return mins >= 135 && mins < 840; // 02:15–14:00 ET
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
  // No blanket platform gate here: practice/paper Auto AI runs without the
  // platform live flag or the live-trading acknowledgement. Live users are still
  // gated — resolveActiveBrokerForUser only returns status='ready' for live when
  // PLATFORM_LIVE_TRADING_ENABLED=true AND the live-ack is accepted.
  if (!inWindow(new Date())) {
    return NextResponse.json({ ok: true, skipped: 'outside_ny_window', users: 0 });
  }

  // Correlation id + staged scan payload — supplied by the Railway scheduler tick.
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

  let totalQualified = 0, totalExecuted = 0, totalSkipped = 0, totalRecs = 0;
  for (const row of (data ?? []) as Array<{ user_id: string; auto_ai_engine?: string }>) {
    const userId = row.user_id;
    const engine = row.auto_ai_engine === 'v3' ? 'v3' : 'ict'; // exactly one engine
    try {
      const resolved = await resolveActiveBrokerForUser(userId);
      // 'ready' already encodes the per-environment gates: practice/paper need
      // only valid creds; live additionally requires platform flag + live-ack.
      if (resolved.brokerCredentialStatus !== 'ready' || !resolved.getCredentials || !resolved.baseUrl) {
        console.log(`${tag} user=${mask(userId)} skipped=${resolved.brokerCredentialStatus}`);
        results.push({ user: mask(userId), skipped: resolved.brokerCredentialStatus });
        continue;
      }
      const creds = await resolved.getCredentials();
      if (!creds) { console.log(`${tag} user=${mask(userId)} skipped=decrypt_failed`); results.push({ user: mask(userId), skipped: 'decrypt_failed' }); continue; }
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

      // Route to EXACTLY one engine for this user (ICT or V3 — never both).
      const auto = await callInternalEndpoint('/api/internal/oanda/auto', { ...credBody, engine });
      const autoData = (auto.ok ? auto.data : null) as {
        scanned?: number;
        qualified?: number;
        executed?: unknown[];
        skipped?: unknown[];
        nearQualifiedPairs?: string[];
        hotPairs?: string[];
        lateEntryPairs?: string[];
      } | null;

      // Recommend-only lifecycle reassessment (ICT engine only).
      let reassess: unknown = null;
      let recs = 0;
      if (engine === 'ict') {
        const trades = await ictOpenTradesContext(userId);
        if (trades.length) {
          const r = await callInternalEndpoint('/api/internal/oanda/ict/reassess', { ...credBody, trades });
          reassess = r.ok ? r.data : { error: r.error };
          const recList = (r.ok ? (r.data as { recommendations?: Array<{ reassessDue?: boolean }> })?.recommendations : null) ?? [];
          recs = recList.filter((x) => x?.reassessDue).length;
        }
      }

      const q = autoData?.qualified ?? 0, e = autoData?.executed?.length ?? 0, s = autoData?.skipped?.length ?? 0;
      totalQualified += q; totalExecuted += e; totalSkipped += s; totalRecs += recs;

      addPairs(nearQualifiedPairs, autoData?.nearQualifiedPairs);
      addPairs(hotPairs, autoData?.hotPairs);
      addPairs(lateEntryPairs, autoData?.lateEntryPairs);

      console.log(`${tag} user=${mask(userId)} account=${acct} engine=${engine} scanMode=${scanMode} pairs=${autoData?.scanned ?? 0} qualified=${q} executed=${e} skipped=${s} recommendations=${recs}`);
      results.push({ user: mask(userId), engine, auto: auto.ok ? auto.data : { error: auto.error }, reassess });
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
    `skipped=${totalSkipped} recommendations=${totalRecs} near=${nearQualifiedPairList.length} hot=${hotPairList.length} late=${lateEntryPairList.length}`,
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
    nearQualifiedPairs: nearQualifiedPairList,
    hotPairs: hotPairList,
    lateEntryPairs: lateEntryPairList,
    results,
  });
}
