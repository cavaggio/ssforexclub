import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { resolveActiveBrokerForUser } from '@/lib/brokerResolver';
import { callInternalEndpoint } from '@/lib/scannerProxy';
import { logTradeEvent, type TradeLogRow } from '@/lib/tradeLogs';
import { lifecycleTradeRows, listVisibleTradeLogsForUser } from '@/lib/visibleTradeLogs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CLOSE_GRACE_MS = 90_000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function extractOpenTrades(value: unknown): Record<string, unknown>[] | null {
  const root = record(value);
  const nested = record(root.analysis);
  const candidates = [root.trades, root.openTrades, nested.trades, nested.openTrades];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === 'object' && !Array.isArray(item))
      );
    }
  }

  return null;
}

function tradeIdFromOpenTrade(trade: Record<string, unknown>): string | null {
  for (const value of [trade.tradeId, trade.trade_id, trade.id]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function latestUnclosedOpenEvents(rows: TradeLogRow[]): TradeLogRow[] {
  const closedTradeIds = new Set<string>();
  for (const row of rows) {
    if (
      row.trade_id &&
      (row.event_type === 'closed' || row.event_type === 'manual_close_executed')
    ) {
      closedTradeIds.add(row.trade_id);
    }
  }

  const openedByTradeId = new Map<string, TradeLogRow>();
  for (const row of rows) {
    if (row.event_type !== 'opened' || !row.trade_id || closedTradeIds.has(row.trade_id)) continue;
    if (!openedByTradeId.has(row.trade_id)) openedByTradeId.set(row.trade_id, row);
  }

  return Array.from(openedByTradeId.values());
}

async function reconcileBrokerClosures(userId: string): Promise<{ synced: number; warning: string | null }> {
  const resolved = await resolveActiveBrokerForUser(userId);
  if (
    resolved.activeBroker !== 'oanda' ||
    resolved.brokerCredentialStatus !== 'ready' ||
    !resolved.getCredentials ||
    !resolved.baseUrl
  ) {
    return { synced: 0, warning: null };
  }

  const credentials = await resolved.getCredentials();
  if (!credentials) return { synced: 0, warning: 'Broker credentials could not be decrypted.' };

  const activeResult = await callInternalEndpoint('/api/internal/oanda/active-trades/analysis', {
    apiKey: credentials.token,
    accountId: credentials.accountId,
    baseUrl: resolved.baseUrl,
    environment: resolved.activeEnvironment,
  });

  if (!activeResult.ok) {
    return { synced: 0, warning: `Open-trade sync unavailable: ${activeResult.error}` };
  }

  const activeTrades = extractOpenTrades(activeResult.data);
  if (activeTrades === null) {
    return { synced: 0, warning: 'Open-trade sync returned an unrecognized payload; no close events were inferred.' };
  }

  const openTradeIds = new Set(
    activeTrades.map(tradeIdFromOpenTrade).filter((value): value is string => Boolean(value)),
  );
  const { rows } = await listVisibleTradeLogsForUser(userId, { limit: 200 });
  const candidates = latestUnclosedOpenEvents(lifecycleTradeRows(rows));
  const now = Date.now();
  let synced = 0;

  for (const opened of candidates) {
    if (!opened.trade_id || openTradeIds.has(opened.trade_id)) continue;
    const openedAt = Date.parse(opened.created_at);
    if (Number.isFinite(openedAt) && now - openedAt < CLOSE_GRACE_MS) continue;

    const result = await logTradeEvent({
      userId,
      broker: 'oanda',
      brokerAccountId: credentials.accountId,
      environment: resolved.activeEnvironment as 'practice' | 'live' | 'paper',
      eventType: 'closed',
      instrument: opened.instrument,
      tradeId: opened.trade_id,
      brokerOrderId: opened.broker_order_id ?? opened.trade_id,
      side: opened.side,
      entryPrice: opened.entry_price,
      reason: 'Closed at broker — trade is no longer present in the open-trade list (TP, SL, manual, or broker-side close).',
      rawPayload: {
        detectedBy: 'dashboard_trade_activity_reconciliation',
        openedEventId: opened.id,
        openedAt: opened.created_at,
        reconciledAt: new Date().toISOString(),
      },
      edge: {
        pair: opened.instrument,
        direction: opened.side,
        exitTime: new Date().toISOString(),
      },
    });

    if (result.ok) synced += 1;
  }

  return { synced, warning: null };
}

export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated' }, { status: 401 });
  }

  try {
    const reconciliation = await reconcileBrokerClosures(userId);
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
