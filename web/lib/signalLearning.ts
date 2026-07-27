import 'server-only';

import { getServerSupabase } from './db';
import { sanitizePayload } from './tradeLogs';
import { requestPairPlaybookNarrative } from './pairPlaybookAdvisor';
import {
  HORIZONS,
  buildLearningRecords,
  buildPairPlaybook,
  gradeObservation,
} from './signalLearningCore.js';

type JsonRecord = Record<string, any>;

type LearningCycleInput = {
  userId: string;
  brokerAccountId: string;
  environment: string;
  engine: 'v3' | 'ict' | 'ppr';
  scanMode: string;
  runId: string;
  payload: JsonRecord;
  observedAt?: Date;
};

type LearningResult = {
  ok: boolean;
  observationsWritten: number;
  snapshotsWritten: number;
  outcomesWritten: number;
  error?: string;
  migrationRequired?: boolean;
};

const TABLE_MISSING_CODES = new Set(['42P01', '42703', 'PGRST205', 'PGRST204']);

function errorMessage(error: unknown): string {
  if (!error) return '';
  if (typeof error === 'object' && error && 'message' in error) return String((error as { message?: unknown }).message || '');
  return String(error);
}

function migrationMissing(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: string; message?: string };
  return TABLE_MISSING_CODES.has(String(record.code || '')) ||
    /signal_observations|signal_market_snapshots|signal_outcomes|pair_ai_playbooks/i.test(String(record.message || ''));
}

async function startRun(input: LearningCycleInput, runType: 'scan_capture' | 'outcome_grading' | 'playbook_refresh') {
  try {
    const supabase = getServerSupabase();
    const { data } = await supabase
      .from('edge_learning_runs')
      .insert({
        user_id: input.userId,
        broker_account_id: input.brokerAccountId,
        engine: input.engine,
        run_type: runType,
        metadata: { runId: input.runId, scanMode: input.scanMode },
      })
      .select('id')
      .maybeSingle();
    return data?.id ? String(data.id) : null;
  } catch {
    return null;
  }
}

async function finishRun(id: string | null, values: JsonRecord) {
  if (!id) return;
  try {
    await getServerSupabase()
      .from('edge_learning_runs')
      .update({ completed_at: new Date().toISOString(), ...values })
      .eq('id', id);
  } catch {}
}

export async function recordSignalLearningCycle(input: LearningCycleInput): Promise<LearningResult> {
  const runRecordId = await startRun(input, 'scan_capture');
  try {
    const supabase = getServerSupabase();
    const records = buildLearningRecords({
      ...input,
      observedAt: input.observedAt || new Date(),
    }) as { observations: JsonRecord[]; snapshots: JsonRecord[] };

    const observations = records.observations.map((row) => ({
      ...row,
      raw_payload: sanitizePayload(row.raw_payload),
    }));
    const snapshots = records.snapshots.map((row) => ({
      ...row,
      raw_payload: sanitizePayload(row.raw_payload),
    }));

    let observationsWritten = 0;
    let snapshotsWritten = 0;

    if (snapshots.length) {
      const { error } = await supabase
        .from('signal_market_snapshots')
        .upsert(snapshots, { onConflict: 'snapshot_key', ignoreDuplicates: true });
      if (error) throw error;
      snapshotsWritten = snapshots.length;
    }

    if (observations.length) {
      const { error } = await supabase
        .from('signal_observations')
        .upsert(observations, { onConflict: 'observation_key', ignoreDuplicates: true });
      if (error) throw error;
      observationsWritten = observations.length;
    }

    const outcomesWritten = await gradePendingSignalObservations({
      userId: input.userId,
      brokerAccountId: input.brokerAccountId,
      engine: input.engine,
    });

    await finishRun(runRecordId, {
      success: true,
      observations_written: observationsWritten,
      snapshots_written: snapshotsWritten,
      outcomes_written: outcomesWritten,
    });

    console.log(
      `[SIGNAL_LEARNING][${input.engine.toUpperCase()}] account=${input.brokerAccountId} ` +
      `observations=${observationsWritten} snapshots=${snapshotsWritten} outcomes=${outcomesWritten}`,
    );

    return { ok: true, observationsWritten, snapshotsWritten, outcomesWritten };
  } catch (error) {
    const message = errorMessage(error);
    const missing = migrationMissing(error);
    console.warn(`[SIGNAL_LEARNING] capture skipped: ${message}`);
    await finishRun(runRecordId, { success: false, error: message });
    return {
      ok: false,
      observationsWritten: 0,
      snapshotsWritten: 0,
      outcomesWritten: 0,
      error: message,
      migrationRequired: missing,
    };
  }
}

export async function gradePendingSignalObservations({
  userId,
  brokerAccountId,
  engine,
  now = new Date(),
}: {
  userId: string;
  brokerAccountId: string;
  engine: 'v3' | 'ict' | 'ppr';
  now?: Date;
}): Promise<number> {
  const supabase = getServerSupabase();
  const oldest = new Date(now.getTime() - 3 * 24 * 60 * 60_000).toISOString();
  const due = new Date(now.getTime() - 15 * 60_000).toISOString();

  const { data: observations, error } = await supabase
    .from('signal_observations')
    .select('id,pair,direction,observed_at,entry_price,stop_loss,take_profit,projected_rr,outcome_state')
    .eq('user_id', userId)
    .eq('broker_account_id', brokerAccountId)
    .eq('engine', engine)
    .in('outcome_state', ['pending', 'partial'])
    .gte('observed_at', oldest)
    .lte('observed_at', due)
    .order('observed_at', { ascending: true })
    .limit(150);
  if (error) {
    if (migrationMissing(error)) return 0;
    throw error;
  }
  if (!observations?.length) return 0;

  const gradeable = observations.filter((row) =>
    Number.isFinite(Number(row.entry_price)) &&
    Number.isFinite(Number(row.stop_loss)) &&
    row.direction,
  );
  const ungradeable = observations.filter((row) => !gradeable.includes(row));
  if (ungradeable.length) {
    await supabase
      .from('signal_observations')
      .update({ outcome_state: 'ungradeable', updated_at: now.toISOString() })
      .in('id', ungradeable.map((row) => row.id));
  }
  if (!gradeable.length) return 0;

  const observationIds = gradeable.map((row) => row.id);
  const pairs = [...new Set(gradeable.map((row) => row.pair))];
  const earliest = String(gradeable[0].observed_at);
  const [{ data: existing, error: existingError }, { data: snapshots, error: snapshotError }] = await Promise.all([
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
      .order('observed_at', { ascending: true }),
  ]);
  if (existingError) throw existingError;
  if (snapshotError) throw snapshotError;

  const existingKeys = new Set(
    (existing || []).map((row) => `${row.observation_id}:${row.horizon_minutes}`),
  );
  const snapshotsByPair = new Map<string, JsonRecord[]>();
  for (const snapshot of snapshots || []) {
    const list = snapshotsByPair.get(snapshot.pair) || [];
    list.push(snapshot);
    snapshotsByPair.set(snapshot.pair, list);
  }

  const outcomes: JsonRecord[] = [];
  const completedByObservation = new Map<string, Set<number>>();
  for (const row of existing || []) {
    const set = completedByObservation.get(row.observation_id) || new Set<number>();
    set.add(Number(row.horizon_minutes));
    completedByObservation.set(row.observation_id, set);
  }

  for (const observation of gradeable) {
    const pairSnapshots = snapshotsByPair.get(observation.pair) || [];
    for (const horizon of HORIZONS as number[]) {
      const key = `${observation.id}:${horizon}`;
      if (existingKeys.has(key)) continue;
      const graded = gradeObservation({ observation, snapshots: pairSnapshots, horizonMinutes: horizon });
      if (!graded) continue;
      outcomes.push({
        ...graded,
        raw_payload: sanitizePayload(graded.raw_payload),
      });
      const set = completedByObservation.get(observation.id) || new Set<number>();
      set.add(horizon);
      completedByObservation.set(observation.id, set);
    }
  }

  if (outcomes.length) {
    const { error: outcomeError } = await supabase
      .from('signal_outcomes')
      .upsert(outcomes, { onConflict: 'observation_id,horizon_minutes' });
    if (outcomeError) throw outcomeError;
  }

  await Promise.all(gradeable.map(async (observation) => {
    const count = completedByObservation.get(observation.id)?.size || 0;
    if (!count) return;
    await supabase
      .from('signal_observations')
      .update({
        outcome_state: count >= HORIZONS.length ? 'resolved' : 'partial',
        updated_at: now.toISOString(),
      })
      .eq('id', observation.id);
  }));

  return outcomes.length;
}

async function rowsForPair(view: string, filters: JsonRecord): Promise<JsonRecord[]> {
  let query = getServerSupabase().from(view).select('*');
  for (const [key, value] of Object.entries(filters)) query = query.eq(key, value);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as JsonRecord[];
}

export async function refreshPairPlaybooksForAccount({
  userId,
  brokerAccountId,
  engine,
}: {
  userId: string;
  brokerAccountId: string;
  engine: 'v3' | 'ict' | 'ppr';
}): Promise<{ ok: boolean; written: number; playbooks: JsonRecord[]; error?: string; migrationRequired?: boolean }> {
  const input: LearningCycleInput = {
    userId,
    brokerAccountId,
    environment: 'unknown',
    engine,
    scanMode: 'playbook_refresh',
    runId: `playbook-${Date.now()}`,
    payload: {},
  };
  const runRecordId = await startRun(input, 'playbook_refresh');

  try {
    await gradePendingSignalObservations({ userId, brokerAccountId, engine });
    const summaries = await rowsForPair('pair_summary_stats', {
      user_id: userId,
      broker_account_id: brokerAccountId,
      engine,
      horizon_minutes: 60,
    });

    const written: JsonRecord[] = [];
    for (const summary of summaries) {
      const pair = String(summary.pair);
      const [timeStats, confirmationStats, comboStats, regimeStats] = await Promise.all([
        rowsForPair('pair_time_edge_stats', {
          user_id: userId, broker_account_id: brokerAccountId, engine, pair, horizon_minutes: 60,
        }),
        rowsForPair('pair_confirmation_edge_stats', {
          user_id: userId, broker_account_id: brokerAccountId, engine, pair, horizon_minutes: 60,
        }),
        rowsForPair('pair_confirmation_combo_stats', {
          user_id: userId, broker_account_id: brokerAccountId, engine, pair, horizon_minutes: 60,
        }),
        rowsForPair('pair_regime_edge_stats', {
          user_id: userId, broker_account_id: brokerAccountId, engine, pair, horizon_minutes: 60,
        }),
      ]);

      const profile = buildPairPlaybook({
        pair,
        engine,
        summary,
        timeStats,
        confirmationStats,
        comboStats,
        regimeStats,
      }) as JsonRecord;
      const narrative = await requestPairPlaybookNarrative(profile);

      const { data: latest, error: latestError } = await getServerSupabase()
        .from('pair_ai_playbooks')
        .select('version')
        .eq('user_id', userId)
        .eq('broker_account_id', brokerAccountId)
        .eq('engine', engine)
        .eq('pair', pair)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (latestError) throw latestError;
      const version = Number(latest?.version || 0) + 1;

      await getServerSupabase()
        .from('pair_ai_playbooks')
        .update({ is_current: false })
        .eq('user_id', userId)
        .eq('broker_account_id', brokerAccountId)
        .eq('engine', engine)
        .eq('pair', pair)
        .eq('is_current', true);

      const row = {
        user_id: userId,
        broker_account_id: brokerAccountId,
        engine,
        pair,
        version,
        is_current: true,
        status: profile.status,
        evidence_start_at: summary.evidence_start_at,
        evidence_end_at: summary.evidence_end_at,
        sample_size: profile.sampleSize,
        wins: profile.wins,
        losses: profile.losses,
        win_rate: profile.winRate,
        expectancy_r: profile.expectancyR,
        profit_factor: profile.profitFactor,
        recommendation_stage: profile.stage,
        preferred_scalp_windows: profile.preferredWindows,
        valuable_confirmations: profile.valuableConfirmations,
        weak_confirmations: profile.weakConfirmations,
        avoid_conditions: profile.avoidConditions,
        statistical_profile: {
          strongCombinations: profile.strongCombinations,
          safeguards: profile.safeguards,
          summary,
        },
        ai_summary: narrative,
        validator: {
          approvedForLiveCalibration: false,
          reason: 'Phase 1 stores and shadows pair learning. Live thresholds remain unchanged.',
          hardGatesPreserved: ['risk', 'daily_drawdown', 'rr', 'spread', 'news', 'margin', 'duplicate', 'broker'],
        },
        max_confidence_adjustment: 0,
      };

      const { data: inserted, error: insertError } = await getServerSupabase()
        .from('pair_ai_playbooks')
        .insert(row)
        .select('*')
        .single();
      if (insertError) throw insertError;
      written.push(inserted as JsonRecord);
    }

    await finishRun(runRecordId, { success: true, playbooks_written: written.length });
    return { ok: true, written: written.length, playbooks: written };
  } catch (error) {
    const message = errorMessage(error);
    await finishRun(runRecordId, { success: false, error: message });
    return {
      ok: false,
      written: 0,
      playbooks: [],
      error: message,
      migrationRequired: migrationMissing(error),
    };
  }
}

export async function getSignalLearningDashboard({
  userId,
  brokerAccountId,
  engine = null,
}: {
  userId: string;
  brokerAccountId: string;
  engine?: 'v3' | 'ict' | 'ppr' | null;
}) {
  const supabase = getServerSupabase();
  const scoped = <T extends { eq: (key: string, value: string) => T }>(query: T) => {
    let next = query.eq('user_id', userId).eq('broker_account_id', brokerAccountId);
    if (engine) next = next.eq('engine', engine);
    return next;
  };

  const [playbooksResult, summariesResult, timeResult, confirmationResult] = await Promise.all([
    scoped(supabase.from('pair_ai_playbooks').select('*') as any)
      .eq('is_current', true)
      .order('pair', { ascending: true }),
    scoped(supabase.from('pair_summary_stats').select('*') as any)
      .eq('horizon_minutes', 60)
      .order('expectancy_r', { ascending: false }),
    scoped(supabase.from('pair_time_edge_stats').select('*') as any)
      .eq('horizon_minutes', 60)
      .gte('outcomes', 3)
      .order('expectancy_r', { ascending: false })
      .limit(80),
    scoped(supabase.from('pair_confirmation_edge_stats').select('*') as any)
      .eq('horizon_minutes', 60)
      .gte('outcomes', 3)
      .order('expectancy_lift_r', { ascending: false })
      .limit(100),
  ]);

  for (const result of [playbooksResult, summariesResult, timeResult, confirmationResult]) {
    if (result.error) throw result.error;
  }

  return {
    playbooks: playbooksResult.data || [],
    summaries: summariesResult.data || [],
    timeStats: timeResult.data || [],
    confirmationStats: confirmationResult.data || [],
    safeguards: {
      mode: 'display_and_shadow_only',
      liveThresholdsChanged: false,
      maxConfidenceAdjustment: 0,
    },
  };
}
