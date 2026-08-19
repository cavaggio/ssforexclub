import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { lifecycleTradeRows, listVisibleTradeLogsForUser } from '@/lib/visibleTradeLogs';
import { canonicalizeTradeActivityRows } from '@/lib/tradeActivityCanonical.js';
import { reconcileBrokerClosuresForUser } from '@/lib/tradeActivityReconciliation';
import { isSameNewYorkTradingDay, newYorkDateKey } from '@/lib/tradingDay.js';
import { getServerSupabase } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated' }, { status: 401 });
  }

  try {
    const reconciliation = await reconcileBrokerClosuresForUser(userId);
    const now = new Date();
    const tradingDateKey = newYorkDateKey(now);
    const { rows } = await listVisibleTradeLogsForUser(userId, { limit: 200 });
    let activity = canonicalizeTradeActivityRows(
      lifecycleTradeRows(rows).filter((row) => isSameNewYorkTradingDay(row.created_at, now)),
    ).slice(0, 50);

    const tradeIds = [...new Set(activity.map((row) => row.trade_id).filter(Boolean))] as string[];
    if (tradeIds.length) {
      try {
        const { data: lifecycles, error: lifecycleError } = await getServerSupabase()
          .from('actual_trade_lifecycles')
          .select('id,broker_trade_id,candidate_signal_id,signal_observation_id,d1_state,h4_state,h1_state,h1_momentum,m5_authorization,m5_trigger_age_bars,po3_stage,htf_liquidity_condition,exit_reason,realized_r,mfe_pips,mae_pips,mfe_r,mae_r,failure_reasons,learning_adjustment,applied_learning_audit_id,learning_applied,entry_context')
          .eq('user_id', userId)
          .in('broker_trade_id', tradeIds);
        if (lifecycleError) throw lifecycleError;
        const byTradeId = new Map((lifecycles || []).map((row) => [String(row.broker_trade_id), row]));
        activity = activity.map((row) => ({
          ...row,
          lifecycle: row.trade_id ? byTradeId.get(row.trade_id) || null : null,
        }));
      } catch (contextError) {
        console.warn('[TRADE_ACTIVITY] lifecycle context unavailable:', contextError instanceof Error ? contextError.message : String(contextError));
      }
    }

    return NextResponse.json({
      ok: true,
      rows: activity,
      tradingDateKey,
      timeZone: 'America/New_York',
      syncedClosed: reconciliation.synced,
      syncWarning: reconciliation.warning,
      refreshedAt: now.toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[TRADE_ACTIVITY] failed:', message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
