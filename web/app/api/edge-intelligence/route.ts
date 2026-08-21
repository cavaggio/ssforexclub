/**
 * web/app/api/edge-intelligence/route.ts
 *
 * Signal Stack V3 — persistent Edge Intelligence history endpoint.
 *
 * IMPORTANT: this is intentionally separate from the dashboard's New York
 * "Today's Trade Activity" window. Edge Intelligence reads persistent broker
 * history across a rolling 30-calendar-day window independently per account.
 */

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { generateAttributionReport } from '@/lib/edgeAnalytics';
import { reconcileBrokerClosuresForUser } from '@/lib/tradeActivityReconciliation';
import { loadEdgeHistoryByAccount } from '@/lib/edgeHistory';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const row = error as Record<string, unknown>;
    const values = [row.message, row.details, row.hint, row.code]
      .filter((value) => typeof value === 'string' && value.trim()) as string[];
    if (values.length) return values.join(' · ');
    try {
      return JSON.stringify(error);
    } catch {
      return 'Unknown Edge Intelligence error';
    }
  }
  return String(error ?? 'Unknown Edge Intelligence error');
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated' }, { status: 401 });
  }

  try {
    // Reconcile immediately on every Edge refresh. Edge never waits for the
    // scheduled end-of-day learning/backfill run before reading closed trades.
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
        historySource: history.sourceMode,
        historyWarning: history.sourceWarning,
        accountCount: accountReports.length,
        retentionDays: history.retentionDays,
        tradesPerAccount: history.tradesPerAccount,
        lifecycleRowsScanned: history.lifecycleRowsScanned,
        tradesLoaded: accountReports.reduce((sum, account) => sum + account.tradesLoaded, 0),
        syncedClosed: reconciliation.synced,
        syncWarning: reconciliation.warning,
      },
    });
  } catch (err) {
    const message = errorText(err);
    console.error('[EDGE_INTELLIGENCE] historical read failed:', message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
