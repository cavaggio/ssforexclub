import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { lifecycleTradeRows, listVisibleTradeLogsForUser } from '@/lib/visibleTradeLogs';
import { reconcileBrokerClosuresForUser } from '@/lib/tradeActivityReconciliation';
import { isSameNewYorkTradingDay, newYorkDateKey } from '@/lib/tradingDay.js';

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
    const activity = lifecycleTradeRows(rows)
      .filter((row) => isSameNewYorkTradingDay(row.created_at, now))
      .slice(0, 50);

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
