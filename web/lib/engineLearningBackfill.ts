import 'server-only';

import { getServerSupabase } from './db';
import { sanitizePayload } from './tradeLogs';
import { HORIZONS, gradeObservation } from './signalLearningCore.js';

type Engine = 'ict' | 'ppr' | 'v3';
type JsonRecord = Record<string, any>;

export type EngineLearningBackfillResult = {
  ok: boolean;
  engine: Engine;
  brokerAccountId: string;
  tradingDaysRequested: number;
  tradingDayKeys: string[];
  observationsConsidered: number;
  outcomesWritten: number;
  accountAccuracy: JsonRecord | null;
  pairAccuracy: JsonRecord[];
  error?: string;
  migrationRequired?: boolean;
};

const TABLE_MISSING_CODES = new Set(['42P01', '42703', 'PGRST205', 'PGRST204']);

function messageOf(error: unknown): string {
  if (!error) return '';
  if (typeof error === 'object' && 'message' in error) return String((error as { message?: unknown }).message || '');
  return String(error);
}

function migrationMissing(error: unknown): boolean {
  const record = error && typeof error === 'object' ? error as { code?: string; message?: string } : {};
  return TABLE_MISSING_CODES.has(String(record.code || '')) ||
    /engine_account_accuracy_7d|engine_account_pair_accuracy_7d|engine_learning_backfill_runs|signal_observations|signal_outcomes/i
      .test(String(record.message || error || ''));
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

async function recentExecutedTradingDays({
  userId,
  brokerAccountId,
  engine,
  tradingDays,
  calendarLookbackDays,
  now,
}: {
  userId: string;
  brokerAccountId: string;
  engine: Engine;
  tradingDays: number;
  calendarLookbackDays: number;
  now: Date;
}): Promise<string[]> {
  const cutoff = new Date(now.getTime() - calendarLookbackDays * 24 * 60 * 60_000).toISOString();
  const { data, error } = await getServerSupabase()
    .from('signal_observations')
    .select('ny_date,observed_at')
    .eq('user_id', userId)
    .eq('broker_account_id', brokerAccountId)
    .eq('engine', engine)
    .eq('status', 'executed')
    .gte('observed_at', cutoff)
    .lte('observed_at', now.toISOString())
    .order('observed_at', { ascending: false })
    .limit(5000);
  if (error) throw error;

  const days: string[] = [];
  const seen = new Set<string>();
  for (const row of data || []) {
    const key = String(row.ny_date || '').slice(0, 10);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    days.push(key);
    if (days.length >= tradingDays) break;
  }
  return days;
}

export async function backfillEngineLearningWindow({
  userId,
  brokerAccountId,
  engine,
  tradingDays = 7,
  calendarLookbackDays = 14,
  now = new Date(),
}: {
  userId: string;
  brokerAccountId: string;
  engine: Engine;
  tradingDays?: number;
  calendarLookbackDays?: number;
  now?: Date;
}): Promise<EngineLearningBackfillResult> {
  const requestedDays = boundedInteger(tradingDays, 7, 1, 30);
  const lookbackDays = boundedInteger(calendarLookbackDays, 14, requestedDays, 60);

  try {
    const supabase = getServerSupabase();
    const tradingDayKeys = await recentExecutedTradingDays({
      userId,
      brokerAccountId,
      engine,
      tradingDays: requestedDays,
      calendarLookbackDays: lookbackDays,
      now,
    });

    if (!tradingDayKeys.length) {
      return {
        ok: true,
        engine,
        brokerAccountId,
        tradingDaysRequested: requestedDays,
        tradingDayKeys: [],
        observationsConsidered: 0,
        outcomesWritten: 0,
        accountAccuracy: null,
        pairAccuracy: [],
      };
    }

    const { data: observations, error: observationsError } = await supabase
      .from('signal_observations')
      .select('id,pair,direction,observed_at,entry_price,stop_loss,take_profit,projected_rr,outcome_state,ny_date')
      .eq('user_id', userId)
      .eq('broker_account_id', brokerAccountId)
      .eq('engine', engine)
      .eq('status', 'executed')
      .in('ny_date', tradingDayKeys)
      .order('observed_at', { ascending: true })
      .limit(2500);
    if (observationsError) throw observationsError;

    const gradeable = (observations || []).filter((row) =>
      row.direction &&
      Number.isFinite(Number(row.entry_price)) &&
      Number.isFinite(Number(row.stop_loss)),
    );
    if (!gradeable.length) {
      return {
        ok: true,
        engine,
        brokerAccountId,
        tradingDaysRequested: requestedDays,
        tradingDayKeys,
        observationsConsidered: 0,
        outcomesWritten: 0,
        accountAccuracy: null,
        pairAccuracy: [],
      };
    }

    const observationIds = gradeable.map((row) => row.id);
    const pairs = [...new Set(gradeable.map((row) => String(row.pair)))];
    const earliest = String(gradeable[0].observed_at);
    const [{ data: existing, error: existingError }, { data: snapshots, error: snapshotsError }] = await Promise.all([
      supabase
        .from('signal_outcomes')
        .select('observation_id,horizon_minutes')
        .in('observation_id', observationIds),
      supabase
        .from('signal_market_snapshots')
        .select('pair,observed_at,mid_price')
        .eq('user_id', userId)
        .eq('broker_account_id', brokerAccountId)
        .eq('engine', engine)
        .in('pair', pairs)
        .gte('observed_at', earliest)
        .lte('observed_at', now.toISOString())
        .order('observed_at', { ascending: true })
        .limit(25000),
    ]);
    if (existingError) throw existingError;
    if (snapshotsError) throw snapshotsError;

    const existingKeys = new Set(
      (existing || []).map((row) => `${row.observation_id}:${Number(row.horizon_minutes)}`),
    );
    const completed = new Map<string, Set<number>>();
    for (const row of existing || []) {
      const horizons = completed.get(String(row.observation_id)) || new Set<number>();
      horizons.add(Number(row.horizon_minutes));
      completed.set(String(row.observation_id), horizons);
    }

    const snapshotsByPair = new Map<string, JsonRecord[]>();
    for (const snapshot of snapshots || []) {
      const pair = String(snapshot.pair);
      const list = snapshotsByPair.get(pair) || [];
      list.push(snapshot);
      snapshotsByPair.set(pair, list);
    }

    const outcomes: JsonRecord[] = [];
    for (const observation of gradeable) {
      const pairSnapshots = snapshotsByPair.get(String(observation.pair)) || [];
      for (const horizon of HORIZONS as number[]) {
        const key = `${observation.id}:${horizon}`;
        if (existingKeys.has(key)) continue;
        const graded = gradeObservation({ observation, snapshots: pairSnapshots, horizonMinutes: horizon });
        if (!graded) continue;
        outcomes.push({ ...graded, raw_payload: sanitizePayload(graded.raw_payload) });
        const horizons = completed.get(String(observation.id)) || new Set<number>();
        horizons.add(horizon);
        completed.set(String(observation.id), horizons);
      }
    }

    if (outcomes.length) {
      const { error } = await supabase
        .from('signal_outcomes')
        .upsert(outcomes, { onConflict: 'observation_id,horizon_minutes' });
      if (error) throw error;
    }

    await Promise.all(gradeable.map(async (observation) => {
      const count = completed.get(String(observation.id))?.size || 0;
      if (!count) return;
      await supabase
        .from('signal_observations')
        .update({
          outcome_state: count >= HORIZONS.length ? 'resolved' : 'partial',
          updated_at: now.toISOString(),
        })
        .eq('id', observation.id);
    }));

    const [{ data: accountRows, error: accountError }, { data: pairRows, error: pairError }] = await Promise.all([
      supabase
        .from('engine_account_accuracy_7d')
        .select('*')
        .eq('user_id', userId)
        .eq('broker_account_id', brokerAccountId)
        .eq('engine', engine)
        .eq('horizon_minutes', 60)
        .maybeSingle(),
      supabase
        .from('engine_account_pair_accuracy_7d')
        .select('*')
        .eq('user_id', userId)
        .eq('broker_account_id', brokerAccountId)
        .eq('engine', engine)
        .eq('horizon_minutes', 60)
        .order('expectancy_r', { ascending: false }),
    ]);
    if (accountError) throw accountError;
    if (pairError) throw pairError;

    return {
      ok: true,
      engine,
      brokerAccountId,
      tradingDaysRequested: requestedDays,
      tradingDayKeys,
      observationsConsidered: gradeable.length,
      outcomesWritten: outcomes.length,
      accountAccuracy: accountRows || null,
      pairAccuracy: pairRows || [],
    };
  } catch (error) {
    return {
      ok: false,
      engine,
      brokerAccountId,
      tradingDaysRequested: requestedDays,
      tradingDayKeys: [],
      observationsConsidered: 0,
      outcomesWritten: 0,
      accountAccuracy: null,
      pairAccuracy: [],
      error: messageOf(error),
      migrationRequired: migrationMissing(error),
    };
  }
}
