import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/db';
import { resolveActiveBrokerForUser } from '@/lib/brokerResolver';
import { callInternalEndpoint } from '@/lib/scannerProxy';
import { logTradeEvent } from '@/lib/tradeLogs';
import { edgeSnapshotFromSignal } from '@/lib/edgeSnapshot';
import { recordSignalLearningCycle } from '@/lib/signalLearning';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type ScanMode = 'full' | 'near_recheck' | 'hot_watch' | 'daily_study';
type AutoAiEngine = 'ict' | 'v3' | 'ppr';
type EngineWatchState = {
  nearQualifiedPairs: Set<string>;
  hotPairs: Set<string>;
  lateEntryPairs: Set<string>;
};

const AUTO_AI_ENGINES: readonly AutoAiEngine[] = ['ict', 'v3', 'ppr'];

function inScanWindow(now = new Date()) {
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
  const minutes = (parseInt(read('hour'), 10) % 24) * 60 + parseInt(read('minute'), 10);
  return minutes >= 2 * 60 && minutes < 10 * 60;
}

function normalizeMode(value: unknown): ScanMode {
  const mode = String(value || 'full').toLowerCase();
  if (mode === 'near_recheck' || mode === 'hot_watch' || mode === 'daily_study') return mode;
  return 'full';
}

function normalizeEngine(value: unknown): AutoAiEngine {
  const engine = String(value || 'ict').toLowerCase();
  if (engine === 'v3' || engine === 'ppr') return engine;
  return 'ict';
}

function requestedEngine(value: unknown): AutoAiEngine | null {
  if (value == null || String(value).trim() === '') return null;
  const normalized = String(value).toLowerCase();
  return AUTO_AI_ENGINES.includes(normalized as AutoAiEngine)
    ? normalized as AutoAiEngine
    : null;
}

function normalizePairs(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean))]
    : [];
}

function count(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function scanAccounting(payload: Record<string, any>) {
  const qualified = count(payload.qualified);
  const watching = count(
    payload.watching ??
    payload.watchCount ??
    payload.qualityWatch ??
    (Array.isArray(payload.watchCandidates) ? payload.watchCandidates.length : undefined),
  );
  const scanned = count(payload.scanned, qualified + watching);
  const rejected = count(
    payload.rejectedCount ??
    (Array.isArray(payload.rejected) ? payload.rejected.length : undefined),
    Math.max(0, scanned - qualified - watching),
  );
  const accountedFor = qualified + watching + rejected;
  return {
    scanned,
    qualified,
    watching,
    rejected,
    accountedFor,
    countInvariantOk: payload.countInvariantOk !== false && scanned === accountedFor,
  };
}

function newWatchState(): EngineWatchState {
  return {
    nearQualifiedPairs: new Set<string>(),
    hotPairs: new Set<string>(),
    lateEntryPairs: new Set<string>(),
  };
}

function addPairs(target: Set<string>, value: unknown) {
  if (!Array.isArray(value)) return;
  for (const raw of value) {
    const pair = String(raw || '').trim().toUpperCase();
    if (pair) target.add(pair);
  }
}

function serializeWatchStates(states: Record<AutoAiEngine, EngineWatchState>) {
  return Object.fromEntries(
    AUTO_AI_ENGINES.map((engine) => [engine, {
      nearQualifiedPairs: [...states[engine].nearQualifiedPairs],
      hotPairs: [...states[engine].hotPairs],
      lateEntryPairs: [...states[engine].lateEntryPairs],
    }]),
  );
}

export async function POST(req: Request) {
  const secret = process.env.AUTO_AI_CRON_SECRET;
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch {}

  const scanMode = normalizeMode(body.scanMode);
  if (scanMode !== 'daily_study' && !inScanWindow()) {
    return NextResponse.json({ ok: true, skipped: 'outside_ny_scan_window_02:00-10:00' });
  }

  const runId = typeof body.runId === 'string'
    ? body.runId
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const pairs = normalizePairs(body.pairs);
  const engineFilter = requestedEngine(body.engine);

  if (scanMode === 'daily_study' && (!engineFilter || engineFilter === 'v3')) {
    return NextResponse.json({
      ok: false,
      error: 'Daily market study requires engine ict or ppr.',
    }, { status: 400 });
  }
  if ((scanMode === 'near_recheck' || scanMode === 'hot_watch') && !engineFilter) {
    return NextResponse.json({
      ok: false,
      error: 'Targeted near/hot rechecks require an engine so watchlists cannot cross engine boundaries.',
    }, { status: 400 });
  }
  if ((scanMode === 'near_recheck' || scanMode === 'hot_watch') && pairs.length === 0) {
    return NextResponse.json({ ok: true, runId, scanMode, engine: engineFilter, skipped: 'no_pairs' });
  }

  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('user_trading_settings')
    .select('user_id, auto_ai_engine')
    .eq('auto_ai_trading_enabled', true);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const watchStates: Record<AutoAiEngine, EngineWatchState> = {
    ict: newWatchState(),
    v3: newWatchState(),
    ppr: newWatchState(),
  };
  const results: Record<string, unknown>[] = [];
  const enabledEngines = new Set<AutoAiEngine>();
  let scanned = 0;
  let qualified = 0;
  let watching = 0;
  let rejected = 0;
  let executed = 0;
  let skipped = 0;
  let countMismatches = 0;
  let learningObservations = 0;
  let learningOutcomes = 0;

  for (const row of (data ?? []) as Array<{ user_id: string; auto_ai_engine?: string }>) {
    const configuredEngine = normalizeEngine(row.auto_ai_engine);
    const selectedEngines: AutoAiEngine[] = scanMode === 'daily_study' && engineFilter
      ? [engineFilter]
      : engineFilter
        ? [engineFilter]
        : [...AUTO_AI_ENGINES];
    const selectedEngine = selectedEngines[0] ?? configuredEngine;
    enabledEngines.add(selectedEngine);

    try {
      const resolved = await resolveActiveBrokerForUser(row.user_id);
      if (resolved.brokerCredentialStatus !== 'ready' || !resolved.getCredentials || !resolved.baseUrl) {
        results.push({
          user: row.user_id,
          engine: selectedEngine,
          skipped: resolved.brokerCredentialStatus,
          activeEnvironment: resolved.activeEnvironment,
          reason: resolved.reason,
        });
        continue;
      }

      const credentials = await resolved.getCredentials();
      if (!credentials) {
        results.push({ user: row.user_id, engine: selectedEngine, skipped: 'decrypt_failed' });
        continue;
      }

      for (const selectedEngine of selectedEngines) {
        enabledEngines.add(selectedEngine);

        const result = await callInternalEndpoint('/api/internal/oanda/auto', {
          apiKey: credentials.token,
          accountId: credentials.accountId,
          baseUrl: resolved.baseUrl,
          environment: resolved.activeEnvironment,
          runId: `${runId}-${selectedEngine}`,
          scanMode,
          pairs: scanMode === 'daily_study' ? [] : engineFilter ? pairs : [],
          engine: selectedEngine,
        });

        if (!result.ok) {
          results.push({ user: row.user_id, engine: selectedEngine, error: result.error, status: result.status });
          continue;
        }

        const payload = (result.data ?? {}) as Record<string, any>;
        const accounting = scanAccounting(payload);
        const executedList = Array.isArray(payload.executed) ? payload.executed : [];
        const state = watchStates[selectedEngine];
        const learning = await recordSignalLearningCycle({
          userId: row.user_id,
          brokerAccountId: credentials.accountId,
          environment: resolved.activeEnvironment,
          engine: selectedEngine,
          scanMode,
          runId: `${runId}-${selectedEngine}`,
          payload,
        });

        learningObservations += learning.observationsWritten;
        learningOutcomes += learning.outcomesWritten;
        scanned += accounting.scanned;
        qualified += accounting.qualified;
        watching += accounting.watching;
        rejected += accounting.rejected;
        executed += executedList.length;
        skipped += Array.isArray(payload.skipped) ? payload.skipped.length : 0;
        if (!accounting.countInvariantOk) countMismatches += 1;

        addPairs(state.nearQualifiedPairs, payload.nearQualifiedPairs);
        addPairs(state.hotPairs, payload.hotPairs);
        addPairs(state.lateEntryPairs, payload.lateEntryPairs);
        for (const pair of state.lateEntryPairs) {
          state.nearQualifiedPairs.delete(pair);
          state.hotPairs.delete(pair);
        }

        console.log(
          `[AUTO_AI][${selectedEngine.toUpperCase()}][runId=${runId}] allEnginesActive=true ` +
          `environment=${resolved.activeEnvironment} scanMode=${scanMode} scanned=${accounting.scanned} ` +
          `qualified=${accounting.qualified} watching=${accounting.watching} rejected=${accounting.rejected} ` +
          `executionAllowed=${payload.executionAllowed === true} executed=${executedList.length} ` +
          `learningObservations=${learning.observationsWritten} learningOutcomes=${learning.outcomesWritten}`,
        );

        for (const item of executedList) {
          const signal = item?.signal && typeof item.signal === 'object' ? item.signal : item;
          await logTradeEvent({
            userId: row.user_id,
            broker: (resolved.activeBroker ?? 'oanda') as 'oanda',
            brokerAccountId: credentials.accountId,
            environment: resolved.activeEnvironment as 'practice' | 'live' | 'paper',
            eventType: 'opened',
            engine: selectedEngine,
            strategy: typeof item?.strategy === 'string' ? item.strategy : selectedEngine.toUpperCase(),
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
            recommendation: typeof item?.expectedRR === 'number'
              ? `RR ${item.expectedRR}`
              : `${selectedEngine.toUpperCase()}_AUTO`,
            reason: `Auto AI ${selectedEngine.toUpperCase()} opened trade during all-engine run ${runId}`,
            rawPayload: {
              runId,
              scanMode,
              engine: selectedEngine,
              executionMode: 'all_enabled_engines',
              accounting,
              learning: {
                observationCapture: learning.ok,
                migrationRequired: learning.migrationRequired === true,
              },
              item,
            },
            edge: edgeSnapshotFromSignal(signal),
          });
        }

        results.push({
          user: row.user_id,
          selectedEngine,
          activeEnvironment: resolved.activeEnvironment,
          executionMode: 'all_enabled_engines',
          accounting,
          executionAllowed: payload.executionAllowed === true,
          learning,
          result: payload,
        });
      }
    } catch (err) {
      results.push({
        user: row.user_id,
        engine: selectedEngine,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const engineWatchStates = serializeWatchStates(watchStates);
  const selectedStates = engineFilter ? [watchStates[engineFilter]] : AUTO_AI_ENGINES.map((engine) => watchStates[engine]);
  const aggregateNear = [...new Set(selectedStates.flatMap((state) => [...state.nearQualifiedPairs]))];
  const aggregateHot = [...new Set(selectedStates.flatMap((state) => [...state.hotPairs]))];
  const aggregateLate = [...new Set(selectedStates.flatMap((state) => [...state.lateEntryPairs]))];

  console.log(
    `[AUTO_AI][SUMMARY][runId=${runId}] allEnginesActive=true engineFilter=${engineFilter ?? 'none'} ` +
    `users=${results.length} scanned=${scanned} qualified=${qualified} watching=${watching} ` +
    `rejected=${rejected} executed=${executed} skipped=${skipped} ` +
    `learningObservations=${learningObservations} learningOutcomes=${learningOutcomes}`,
  );

  return NextResponse.json({
    ok: true,
    runId,
    scanMode,
    engine: engineFilter,
    pairs,
    users: results.length,
    scanned,
    qualified,
    watching,
    rejected,
    accountedFor: qualified + watching + rejected,
    countMismatches,
    executed,
    skipped,
    learningObservations,
    learningOutcomes,
    executionMode: 'all_enabled_engines',
    enabledEngines: [...enabledEngines],
    engineWatchStates,
    nearQualifiedPairs: aggregateNear,
    hotPairs: aggregateHot,
    lateEntryPairs: aggregateLate,
    scanWindow: '02:00-10:00 America/New_York, Monday-Friday',
    executionWindow: 'V3/PPR/ICT 02:30-10:00 America/New_York, Monday-Friday',
    dailyStudyWindow: '02:00-02:30 America/New_York, Monday-Friday; execution remains blocked during study',
    results,
  });
}
