/**
 * Authenticated 30-minute reassessment endpoint.
 *
 * OANDA keeps the existing Railway lifecycle reassessment. FTMO reads the
 * position snapshot from the connected MT5 EA and surfaces the hard broker-side
 * protection plan without trying to query or manage an OANDA position.
 *
 * MT5 sizing note: FTMO positions are broker-native `volume` (lots). Any
 * `units` field emitted for generic dashboard compatibility is derived from
 * volume × broker contract size and is never used for MT5 execution.
 */

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { callScannerForCurrentUser } from '@/lib/scannerProxy';
import { resolveActiveBrokerForUser } from '@/lib/brokerResolver';
import { getFtmoPositionsForUser, mt5SymbolToSignalPair } from '@/lib/ftmoPositions';
import { logTradeEvent } from '@/lib/tradeLogs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type ReassessTrade = {
  tradeId?: string;
  instrument?: string;
  direction?: 'long' | 'short';
  units?: number;
  volume?: number;
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

function ftmoReassessment(position: Awaited<ReturnType<typeof getFtmoPositionsForUser>>['positions'][number]) {
  return {
    tradeId: position.ticket,
    instrument: mt5SymbolToSignalPair(position.symbol),
    direction: position.side,
    volume: position.volume,
    sizeUnit: 'lots',
    contractSize: position.contractSize,
    notionalUnits: position.notionalUnits,
    // Generic dashboard compatibility only. This is true notional size.
    units: position.notionalUnits ?? 0,
    currentPnL: position.profit,
    recommendedAction: 'HOLD',
    recommendedStopLoss: position.stopLoss,
    recommendedTakeProfit: position.takeProfit,
    managementReasons: [
      `MT5 position size: ${position.volume} lot(s).`,
      'FTMO position is managed inside SignalStackBridge.',
      'Do not discretionary-close before the protective stop.',
      'Move SL to breakeven at +10 pips.',
      'Take 80% at +15 pips and the final 20% at +18 pips.',
    ],
    lifecycleRecommendation: {
      action: 'hold',
      reason: 'Broker-side FTMO protection is authoritative; no early discretionary close is requested.',
      confidence: 100,
      shouldAutoClose: false,
      autoCloseReason: null,
    },
    source: 'ftmo_mt5',
    brokerManaged: true,
    managedBySignalStack: position.managedBySignalStack,
  };
}

export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated' }, { status: 401 });
  }

  const resolved = await resolveActiveBrokerForUser(userId);
  if (resolved.activeBroker === 'ftmo') {
    try {
      const snapshot = await getFtmoPositionsForUser(userId);
      const trades = snapshot.positions.map(ftmoReassessment);
      const detailPending = snapshot.positionCount > 0 && !snapshot.detailAvailable;

      return NextResponse.json({
        ok: true,
        activeBroker: 'ftmo',
        activeEnvironment: resolved.activeEnvironment,
        executionTransport: 'mt5_ea',
        positionSizeUnit: 'lots',
        reassessment: {
          trades,
          meta: {
            reassessedAt: new Date().toISOString(),
            session: 'FTMO / MT5',
            environment: resolved.activeEnvironment,
            totalActive: snapshot.positionCount,
            autoCloseEnabled: false,
            positionSizeUnit: 'lots',
            recommendationCounts: trades.length ? { hold: trades.length } : {},
            notice: detailPending
              ? `MT5 reports ${snapshot.positionCount} open position(s); detailed position data requires SignalStackBridge v1.22.`
              : snapshot.positionCount === 0
                ? 'No open FTMO positions to reassess.'
                : 'FTMO positions use native MT5 volume (lots) and are managed by the EA hard protection policy; reassessment will not guess an early exit.',
          },
        },
      });
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 502 },
      );
    }
  }

  return callScannerForCurrentUser({
    internalPath: '/api/internal/oanda/active-trades/reassess',
    logTag: 'SCANNER_REASSESS',
    payloadKey: 'reassessment',
    afterCall: async (ctx, result) => {
      if (!result.ok || ctx.broker !== 'oanda') return;
      const reassessment = (result.data ?? {}) as { trades?: ReassessTrade[] };
      const trades = Array.isArray(reassessment.trades) ? reassessment.trades : [];
      await Promise.allSettled(
        trades.flatMap((t) => {
          const rec = t.lifecycleRecommendation;
          const events: Array<Promise<unknown>> = [];
          events.push(
            logTradeEvent({
              userId: ctx.userId,
              broker: 'oanda',
              brokerAccountId: ctx.brokerAccountId,
              environment: ctx.environment as 'practice' | 'live' | 'paper',
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
                broker: 'oanda',
                brokerAccountId: ctx.brokerAccountId,
                environment: ctx.environment as 'practice' | 'live' | 'paper',
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
