/**
 * web/app/api/edge-intelligence/route.ts
 *
 * Signal Stack V3 — Edge Intelligence read endpoint.
 *
 * Returns the current user's strategy-attribution report computed from their
 * own trade_logs rows. Read-only: it reads the event log the app already
 * writes and aggregates it. It never trades, writes, or alters execution.
 *
 * Always filtered by the Clerk session user_id (defense-in-depth on top of the
 * trade_logs deny-all RLS).
 */

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { listTradeLogsForUser } from '@/lib/tradeLogs';
import { generateAttributionReport } from '@/lib/edgeAnalytics';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated' }, { status: 401 });
  }
  try {
    // Pull the most recent window of events. 200 is the listTradeLogsForUser
    // cap; enough to attribute a meaningful sample without a heavy scan.
    const { rows } = await listTradeLogsForUser(userId, { limit: 200 });
    const report = generateAttributionReport(rows, new Date().toISOString());
    return NextResponse.json({ ok: true, report });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[EDGE_INTELLIGENCE] read failed:', message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
