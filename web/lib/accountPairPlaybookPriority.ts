import 'server-only';

import { getServerSupabase } from './db';
import { buildPairPlaybookPriority } from './pairPlaybookPriorityCore.js';

type Engine = 'ict' | 'ppr' | 'v3';
type JsonRecord = Record<string, any>;

function migrationMissing(error: unknown) {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const message = String(record.message || error || '');
  return ['42P01', 'PGRST205'].includes(String(record.code || '')) ||
    /pair_ai_playbooks|pair_playbook_priority_audit/i.test(message);
}

export async function loadAccountPairPlaybookPriority(args: {
  userId: string;
  brokerAccountId: string;
  engine: Engine;
  now?: Date;
}): Promise<JsonRecord> {
  const { userId, brokerAccountId, engine, now = new Date() } = args;
  try {
    const { data, error } = await getServerSupabase()
      .from('pair_ai_playbooks')
      .select(
        'id,pair,version,is_current,status,recommendation_stage,sample_size,win_rate,' +
        'expectancy_r,profit_factor,preferred_scalp_windows,validator',
      )
      .eq('user_id', userId)
      .eq('broker_account_id', brokerAccountId)
      .eq('engine', engine)
      .eq('is_current', true);
    if (error) throw error;
    return {
      ...buildPairPlaybookPriority(data || [], now),
      playbooksLoaded: data?.length || 0,
      migrationRequired: false,
    };
  } catch (error) {
    const base = buildPairPlaybookPriority([], now);
    return {
      ...base,
      enabled: false,
      selectedPairs: [],
      selectedDetails: [],
      evaluations: [],
      playbooksLoaded: 0,
      migrationRequired: migrationMissing(error),
      reason: `Account playbook priority unavailable; continuing the normal scan safely: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export async function recordPairPlaybookPriorityAudit(args: {
  userId: string;
  brokerAccountId: string;
  environment: string;
  engine: Engine;
  runId: string;
  scanMode: string;
  priority: JsonRecord;
  prescanAttempted: boolean;
  prescanOk: boolean | null;
  prescanStatus?: number | null;
  prescanError?: string | null;
}) {
  try {
    const { priority } = args;
    const { error } = await getServerSupabase()
      .from('pair_playbook_priority_audit')
      .upsert({
        user_id: args.userId,
        broker_account_id: args.brokerAccountId,
        environment: args.environment || 'unknown',
        engine: args.engine,
        run_id: args.runId,
        scan_mode: args.scanMode,
        policy_version: String(priority.version || 'unknown'),
        ny_time_bucket: String(priority.nyTimeBucket || ''),
        playbooks_loaded: Number(priority.playbooksLoaded || 0),
        eligible_playbooks: Number(priority.eligibleCount || 0),
        window_matched_playbooks: Number(priority.windowMatchedCount || 0),
        selected_pairs: Array.isArray(priority.selectedPairs) ? priority.selectedPairs : [],
        evaluations: Array.isArray(priority.evaluations) ? priority.evaluations : [],
        prescan_attempted: args.prescanAttempted,
        prescan_ok: args.prescanOk,
        prescan_status: args.prescanStatus ?? null,
        prescan_error: args.prescanError ?? null,
        safeguards: priority.safeguards || {},
      }, { onConflict: 'user_id,broker_account_id,engine,run_id' });
    if (error) throw error;
    return { ok: true, migrationRequired: false };
  } catch (error) {
    const required = migrationMissing(error);
    console.warn(`[PLAYBOOK_PRIORITY] audit write failed: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, migrationRequired: required };
  }
}
