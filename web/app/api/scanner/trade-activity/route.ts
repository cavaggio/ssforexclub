import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { lifecycleTradeRows, listVisibleTradeLogsForUser } from '@/lib/visibleTradeLogs';
import { reconcileBrokerClosuresForUser } from '@/lib/tradeActivityReconciliation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated' }, { status: 401 });
  }

  try {
    const reconciliation = await reconcileBrokerClosuresForUser(userId);
    const { rows } = await listVisibleTradeLogsForUser(userId, { limit: 100 });
    const activity = lifecycleTradeRows(rows).slice(0, 50);

    return NextResponse.json({
      ok: true,
      rows: activity,
      syncedClosed: reconciliation.synced,
      syncWarning: reconciliation.warning,
      refreshedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[TRADE_ACTIVITY] failed:', message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
