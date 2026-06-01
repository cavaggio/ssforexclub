/**
 * web/app/api/scanner/trade-logs/route.ts
 *
 * Authenticated read-only endpoint for the current user's trade history.
 * Filters: instrument, event_type, trade_id, start/end date, limit, cursor.
 *
 * Every query is filtered by the Clerk session's user_id at the DB layer,
 * so a user can only ever read their own rows even though the server uses
 * the service-role key. RLS deny-all is the defense-in-depth fallback.
 *
 * Pagination: cursor is the ISO `created_at` of the oldest row in the previous
 * page (rows are returned DESC by created_at). Pass it as `?cursor=…` to
 * fetch the next page.
 */

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { listTradeLogsForUser, type TradeEventType } from '@/lib/tradeLogs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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
  let limit = 50;
  if (limitRaw) {
    const n = Number(limitRaw);
    if (!Number.isFinite(n) || n < 1) {
      return NextResponse.json({ ok: false, error: 'limit must be a positive integer' }, { status: 400 });
    }
    limit = Math.min(200, Math.floor(n));
  }

  try {
    const { rows, nextCursor } = await listTradeLogsForUser(userId, {
      instrument: sp.get('instrument') ?? undefined,
      eventType: (eventTypeRaw ?? undefined) as TradeEventType | undefined,
      tradeId: sp.get('trade_id') ?? undefined,
      startDate: sp.get('start_date') ?? undefined,
      endDate: sp.get('end_date') ?? undefined,
      cursor: sp.get('cursor') ?? undefined,
      limit,
    });
    return NextResponse.json({ ok: true, rows, nextCursor });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[TRADE_LOGS] read failed:', message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
