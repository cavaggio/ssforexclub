/**
 * web/app/api/edge-intelligence/route.ts
 *
 * Signal Stack V3 — persistent Edge Intelligence history endpoint.
 *
 * IMPORTANT: this is intentionally separate from the dashboard's New York
 * "Today's Trade Activity" window. Edge Intelligence reads reconciled broker
 * lifecycles and analyzes the latest 25 completed trades independently for each
 * broker account.
 */

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { generateAttributionReport } from '@/lib/edgeAnalytics';
import { reconcileBrokerClosuresForUser } from '@/lib/tradeActivityReconciliation';
import { loadEdgeHistoryByAccount } from '@/lib/edgeHistory';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated' }, { status: 401 });
  }

  try {
    const reconciliation = await reconcileBrokerClosuresForUser(userId);
    const history = await loadEdgeHistoryByAccount(userId);
    const generatedAt = new Date().toISOString();

    const accountReports = history.accounts.map((account) => ({
      brokerAccountId: account.brokerAccountId,
      tradesLoaded: account.tradesLoaded,
      report: generateAttributionReport(account.rows, generatedAt),
    }));

    // Backward-compatible top-level report for existing consumers. The Edge UI
    // uses accountReports so results from different broker accounts are not blended.
    const report = accountReports[0]?.report ?? generateAttributionReport([], generatedAt);

    return NextResponse.json({
      ok: true,
      report,
      accountReports,
      source: {
        mode: 'persistent_account_history',
        accountCount: accountReports.length,
        tradesPerAccount: history.tradesPerAccount,
        lifecycleRowsScanned: history.lifecycleRowsScanned,
        tradesLoaded: accountReports.reduce((sum, account) => sum + account.tradesLoaded, 0),
        syncedClosed: reconciliation.synced,
        syncWarning: reconciliation.warning,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[EDGE_INTELLIGENCE] historical read failed:', message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
