/**
 * Authenticated read-only endpoint for the current user's trade history.
 *
 * Reads the production-safe trade_logs shape without filtering successful
 * fallback rows by `status`, so OPENED/CLOSED events remain visible even when
 * the production table uses the compact schema.
 */

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import type { TradeEventType } from '@/lib/tradeLogs';
import { listVisibleTradeLogsForUser } from '@/lib/visibleTradeLogs';

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
    const parsed = Number(limitRaw);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return NextResponse.json({ ok: false, error: 'limit must be a positive integer' }, { status: 400 });
    }
    limit = Math.min(200, Math.floor(parsed));
  }

  try {
    const { rows, nextCursor } = await listVisibleTradeLogsForUser(userId, {
      instrument: sp.get('instrument') ?? undefined,
      eventType: (eventTypeRaw ?? undefined) as TradeEventType | undefined,
      tradeId: sp.get('trade_id') ?? undefined,
      startDate: sp.get('start_date') ?? undefined,
      endDate: sp.get('end_date') ?? undefined,
      cursor: sp.get('cursor') ?? undefined,
      limit,
    });

    return NextResponse.json({ ok: true, rows, nextCursor });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[TRADE_LOGS] read failed:', message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
