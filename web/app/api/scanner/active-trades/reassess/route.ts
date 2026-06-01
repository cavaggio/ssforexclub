/**
 * web/app/api/scanner/active-trades/reassess/route.ts
 *
 * Authenticated, per-user 30-min reassessment endpoint. Calls Railway's
 * internal `/api/internal/oanda/active-trades/reassess` with credentials
 * resolved from the current user's broker connection. Hard-fails (409) when
 * no usable credentials exist — never falls back to platform defaults.
 *
 * After a successful reassessment, writes one `reassessed` row per active
 * trade to Supabase `trade_logs`. Any trade flagged for `shouldAutoClose=true`
 * also emits an `auto_close_recommended` row so the audit trail captures
 * the recommendation even before the user (or future automation) acts on it.
 */

import { callScannerForCurrentUser } from '@/lib/scannerProxy';
import { logTradeEvent } from '@/lib/tradeLogs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type ReassessTrade = {
  tradeId?: string;
  instrument?: string;
  direction?: 'long' | 'short';
  units?: number;
  currentPnL?: number;
  recommendedAction?: string;
  recommendedStopLoss?: number | null;
  recommendedTakeProfit?: number | null;
  lifecycleRecommendation?: {
    action?: string;
    reason?: string;
    confidence?: number;
    shouldAutoClose?: boolean;
    autoCloseReason?: string | null;
  };
  managementReasons?: string[];
};

export async function POST() {
  return callScannerForCurrentUser({
    internalPath: '/api/internal/oanda/active-trades/reassess',
    logTag: 'SCANNER_REASSESS',
    payloadKey: 'reassessment',
    afterCall: async (ctx, result) => {
      if (!result.ok) return;
      const reassessment = (result.data ?? {}) as { trades?: ReassessTrade[] };
      const trades = Array.isArray(reassessment.trades) ? reassessment.trades : [];
      // Best-effort: don't await sequentially to keep latency low. Each
      // logTradeEvent is non-throwing.
      await Promise.allSettled(
        trades.flatMap((t) => {
          const rec = t.lifecycleRecommendation;
          const events: Array<Promise<unknown>> = [];
          events.push(
            logTradeEvent({
              userId: ctx.userId,
              broker: ctx.broker,
              brokerAccountId: ctx.brokerAccountId,
              environment: ctx.environment,
              eventType: 'reassessed',
              instrument: t.instrument ?? null,
              tradeId: t.tradeId ?? null,
              side: t.direction ?? null,
              units: typeof t.units === 'number' ? Math.abs(t.units) : null,
              unrealizedPL: typeof t.currentPnL === 'number' ? t.currentPnL : null,
              tp: typeof t.recommendedTakeProfit === 'number' ? t.recommendedTakeProfit : null,
              sl: typeof t.recommendedStopLoss === 'number' ? t.recommendedStopLoss : null,
              recommendation: rec?.action ?? t.recommendedAction ?? null,
              confidence: typeof rec?.confidence === 'number' ? rec.confidence : null,
              reason: rec?.reason ?? (t.managementReasons ?? []).join(' · ') ?? null,
              rawPayload: { trade: t },
            }),
          );
          if (rec?.shouldAutoClose) {
            events.push(
              logTradeEvent({
                userId: ctx.userId,
                broker: ctx.broker,
                brokerAccountId: ctx.brokerAccountId,
                environment: ctx.environment,
                eventType: 'auto_close_recommended',
                instrument: t.instrument ?? null,
                tradeId: t.tradeId ?? null,
                side: t.direction ?? null,
                units: typeof t.units === 'number' ? Math.abs(t.units) : null,
                unrealizedPL: typeof t.currentPnL === 'number' ? t.currentPnL : null,
                recommendation: rec.action ?? 'close',
                confidence: typeof rec.confidence === 'number' ? rec.confidence : null,
                reason: rec.autoCloseReason ?? rec.reason ?? null,
                rawPayload: { trade: t, lifecycle: rec },
              }),
            );
          }
          return events;
        }),
      );
    },
  });
}
