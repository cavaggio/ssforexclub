import 'server-only';

import { resolveActiveBrokerForUser } from './brokerResolver';
import { callInternalEndpoint } from './scannerProxy';
import { logTradeEvent, type TradeLogRow } from './tradeLogs';
import { lifecycleTradeRows, listVisibleTradeLogsForUser } from './visibleTradeLogs';

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

export type TradeClosureReconciliation = {
  synced: number;
  warning: string | null;
};

/**
 * Reconcile documented opens against OANDA's authoritative open-trade list.
 *
 * This is shared by Trade Activity and Edge Intelligence so visiting either page
 * keeps broker-side TP/SL/manual closures connected to the same event history.
 * It never infers a close after an error or an unrecognized broker payload.
 */
export async function reconcileBrokerClosuresForUser(userId: string): Promise<TradeClosureReconciliation> {
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
    return {
      synced: 0,
      warning: 'Open-trade sync returned an unrecognized payload; no close events were inferred.',
    };
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
      reason: 'Closed at broker — no longer present in OANDA open trades (TP, SL, manual, or broker-side close).',
      rawPayload: {
        detectedBy: 'trade_activity_reconciliation',
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
