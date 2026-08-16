import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { resolveActiveBrokerForUser } from '@/lib/brokerResolver';
import { getServerSupabase } from '@/lib/db';
import { buildAccountCalibrationSnapshot } from '@/lib/accountCalibrationCore.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function missingMigration(error: unknown) {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  return ['42P01', 'PGRST205'].includes(String(record.code || '')) ||
    /actual_trade_lifecycles|engine_learning_adjustment_audit/i.test(String(record.message || error || ''));
}

export async function POST() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ ok: false, error: 'Unauthenticated' }, { status: 401 });

  try {
    const resolved = await resolveActiveBrokerForUser(userId);
    if (resolved.brokerCredentialStatus !== 'ready' || !resolved.getCredentials) {
      return NextResponse.json({ ok: false, error: resolved.reason }, { status: 409 });
    }
    const credentials = await resolved.getCredentials();
    if (!credentials?.accountId) {
      return NextResponse.json({ ok: false, error: 'Broker account could not be resolved.' }, { status: 409 });
    }

    const supabase = getServerSupabase();
    const [lifecycleResult, auditResult, priorityResult] = await Promise.all([
      supabase
        .from('actual_trade_lifecycles')
        .select('engine,state,result,opened_at,closed_at,entry_price,stop_loss,take_profit,realized_r,opening_snapshot,learning_audit_id')
        .eq('user_id', userId)
        .eq('broker_account_id', credentials.accountId)
        .eq('state', 'closed')
        .order('closed_at', { ascending: false })
        .limit(60),
      supabase
        .from('engine_learning_adjustment_audit')
        .select('user_id,engine,pair,observed_at,created_at,original_confidence,final_confidence,combined_adjustment')
        .eq('broker_account_id', credentials.accountId)
        .order('observed_at', { ascending: false })
        .limit(200),
      supabase
        .from('pair_playbook_priority_audit')
        .select('engine,created_at,ny_time_bucket,playbooks_loaded,eligible_playbooks,window_matched_playbooks,selected_pairs,prescan_attempted,prescan_ok')
        .eq('user_id', userId)
        .eq('broker_account_id', credentials.accountId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (lifecycleResult.error) throw lifecycleResult.error;
    if (auditResult.error) throw auditResult.error;

    // Historical audit rows pre-date user_id propagation. Exact broker account
    // scope remains mandatory; current and future rows also match the user.
    const audits = (auditResult.data || []).filter((row) => !row.user_id || row.user_id === userId);
    const calibration = buildAccountCalibrationSnapshot({
      lifecycles: lifecycleResult.data || [],
      audits,
      priorityAudit: priorityResult.error ? null : priorityResult.data,
      brokerAccountId: credentials.accountId,
      environment: resolved.activeEnvironment,
    });

    return NextResponse.json({
      ok: true,
      activeBroker: resolved.activeBroker,
      activeEnvironment: resolved.activeEnvironment,
      calibration,
      playbookAuditMigrationRequired: priorityResult.error ? missingMigration(priorityResult.error) : false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, error: message, migrationRequired: missingMigration(error) },
      { status: missingMigration(error) ? 503 : 500 },
    );
  }
}
