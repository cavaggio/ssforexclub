/**
 * web/app/api/edge-intelligence/route.ts
 *
 * Signal Stack V3 — Edge Intelligence read endpoint.
 *
 * Edge Intelligence now consumes the exact same normalized trade activity event
 * stream shown on the dashboard. Visiting this endpoint also runs the shared,
 * guarded OANDA closure reconciliation so broker-side TP/SL/manual closes are
 * available to attribution even when the user opens Edge Intelligence directly.
 */

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { generateAttributionReport } from '@/lib/edgeAnalytics';
import { reconcileBrokerClosuresForUser } from '@/lib/tradeActivityReconciliation';
import { lifecycleTradeRows, listVisibleTradeLogsForUser } from '@/lib/visibleTradeLogs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated' }, { status: 401 });
  }

  try {
    const reconciliation = await reconcileBrokerClosuresForUser(userId);
    const { rows } = await listVisibleTradeLogsForUser(userId, { limit: 200 });
    const lifecycleRows = lifecycleTradeRows(rows);
    const report = generateAttributionReport(lifecycleRows, new Date().toISOString());

    return NextResponse.json({
      ok: true,
      report,
      source: {
        eventRows: lifecycleRows.length,
        syncedClosed: reconciliation.synced,
        syncWarning: reconciliation.warning,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[EDGE_INTELLIGENCE] read failed:', message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
