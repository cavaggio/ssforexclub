/**
 * Authenticated read-only endpoint for the current user's saved trade history.
 *
 * The default view returns the latest 50 lifecycle trade records (opens,
 * partial closes, and closes). Operational events such as reassessments remain
 * available only when an explicit event_type filter is requested.
 */

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import type { TradeEventType } from '@/lib/tradeLogs';
import { lifecycleTradeRows, listVisibleTradeLogsForUser } from '@/lib/visibleTradeLogs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_TRADE_LOG_ROWS = 50;

const VALID_EVENT_TYPES: ReadonlySet<TradeEventType> = new Set([
  'opened',
  'closed',
  'partial_closed',
  'tp_updated',
  'sl_updated',
  'reassessed',
  'auto_close_recommended',
  'manual_close_executed',
  'error',
]);

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated' }, { status: 401 });
  }

  const url = new URL(req.url);
  const sp = url.searchParams;
  const eventTypeRaw = sp.get('event_type');

  if (eventTypeRaw && !VALID_EVENT_TYPES.has(eventTypeRaw as TradeEventType)) {
    return NextResponse.json(
      { ok: false, error: `Invalid event_type "${eventTypeRaw}"` },
      { status: 400 },
    );
  }

  const limitRaw = sp.get('limit');
  let requestedLimit = MAX_TRADE_LOG_ROWS;
  if (limitRaw) {
    const parsed = Number(limitRaw);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return NextResponse.json({ ok: false, error: 'limit must be a positive integer' }, { status: 400 });
    }
    requestedLimit = Math.min(MAX_TRADE_LOG_ROWS, Math.floor(parsed));
  }

  try {
    // Fetch a wider source window because lifecycle filtering happens after the
    // production-safe row normalization and operational events can be interleaved.
    const { rows } = await listVisibleTradeLogsForUser(userId, {
      instrument: sp.get('instrument') ?? undefined,
      tradeId: sp.get('trade_id') ?? undefined,
      startDate: sp.get('start_date') ?? undefined,
      endDate: sp.get('end_date') ?? undefined,
      cursor: sp.get('cursor') ?? undefined,
      limit: 200,
    });

    const filtered = eventTypeRaw
      ? rows.filter((row) => row.event_type === eventTypeRaw)
      : lifecycleTradeRows(rows);
    const history = filtered.slice(0, requestedLimit);

    return NextResponse.json({
      ok: true,
      rows: history,
      nextCursor: null,
      maxRows: MAX_TRADE_LOG_ROWS,
      historyMode: eventTypeRaw ? 'event_filter' : 'last_50_trades',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[TRADE_LOGS] read failed:', message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
