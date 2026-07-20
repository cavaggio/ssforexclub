/**
 * web/app/api/scanner/trade/route.ts
 *
 * Authenticated, per-user manual execution endpoint for a qualified native V3
 * signal shown under Recent Signals. The browser may submit the displayed
 * candidate, but Railway always refreshes the exact pair from current OANDA
 * pricing/candles and requires native Stage 1 + Stage 2 to remain complete
 * before an order can reach the broker executor.
 *
 * Never falls back to platform-default credentials. Never reaches Railway's
 * public /api/oanda/* endpoints. The user's token never touches the browser.
 */

import { NextResponse } from 'next/server';
import { callScannerForCurrentUser } from '@/lib/scannerProxy';
import { logTradeEvent } from '@/lib/tradeLogs';
import { edgeSnapshotFromSignal } from '@/lib/edgeSnapshot';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type SignalInput = {
  pair?: unknown;
  direction?: unknown;
  architecture?: unknown;
  legacyScannerUsed?: unknown;
  legacyConfirmationsUsed?: unknown;
  entryTiming?: { status?: unknown } | null;
  qualityConfirmation?: {
    stage1?: { allowed?: unknown } | null;
    stage2?: { allowed?: unknown } | null;
  } | null;
  [k: string]: unknown;
};

function validateSignal(raw: unknown): { ok: true; signal: Record<string, unknown> } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'Missing signal in request body' };
  }
  const signal = raw as SignalInput;
  if (typeof signal.pair !== 'string' || !/^[A-Z]{3}_[A-Z]{3}$/.test(signal.pair)) {
    return { ok: false, error: 'Invalid signal.pair (expected e.g. EUR_USD)' };
  }
  if (signal.direction !== 'long' && signal.direction !== 'short') {
    return { ok: false, error: 'Invalid signal.direction (must be long or short)' };
  }
  if (signal.architecture !== 'independent_v3_raw_market_data') {
    return { ok: false, error: 'Only independent native V3 Recent Signals can be executed manually' };
  }
  if (signal.legacyScannerUsed === true || signal.legacyConfirmationsUsed === true) {
    return { ok: false, error: 'Legacy scanner or legacy confirmation payloads cannot be executed' };
  }
  if (signal.qualityConfirmation?.stage1?.allowed !== true) {
    return { ok: false, error: 'V3 Stage 1 is not complete for this Recent Signal' };
  }
  if (signal.qualityConfirmation?.stage2?.allowed !== true) {
    return { ok: false, error: 'V3 Stage 2 is not complete for this Recent Signal' };
  }
  if (signal.entryTiming?.status !== 'valid_entry') {
    return { ok: false, error: 'The displayed V3 entry is no longer marked valid_entry' };
  }
  return { ok: true, signal: signal as Record<string, unknown> };
}

export async function POST(req: Request) {
  let body: { signal?: unknown } = {};
  try {
    body = (await req.json()) as { signal?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: 'Body must be JSON' }, { status: 400 });
  }
  const validated = validateSignal(body.signal);
  if (!validated.ok) {
    return NextResponse.json({ ok: false, error: validated.error }, { status: 400 });
  }

  return callScannerForCurrentUser({
    internalPath: '/api/internal/oanda/v3-trade',
    logTag: 'V3_RECENT_SIGNAL_TRADE',
    payloadKey: 'trade',
    // Practice/paper execution remains available. Live execution still requires
    // the platform live flag and the user's live-trading acknowledgment upstream.
    requireLive: false,
    extraBody: {
      signal: validated.signal,
      executionSource: 'recent_signals_v3',
    },
    afterCall: async (ctx, result) => {
      const signal = validated.signal;
      const trade = (result.data ?? {}) as Record<string, unknown>;
      const opened = result.ok && trade.success === true;
      const reasonStr = result.ok
        ? typeof trade.reason === 'string' ? trade.reason : null
        : result.error ?? null;
      await logTradeEvent({
        userId: ctx.userId,
        broker: ctx.broker,
        brokerAccountId: ctx.brokerAccountId,
        environment: ctx.environment,
        eventType: opened ? 'opened' : 'error',
        instrument: typeof signal.pair === 'string' ? signal.pair : null,
        tradeId: typeof trade.tradeId === 'string' ? trade.tradeId : null,
        brokerOrderId: typeof trade.tradeId === 'string' ? trade.tradeId : null,
        side: signal.direction === 'long' || signal.direction === 'short' ? signal.direction : null,
        units: typeof trade.units === 'number' ? Math.abs(trade.units) : null,
        entryPrice: typeof trade.fillPrice === 'number' ? trade.fillPrice : null,
        sl: typeof signal.stopLoss === 'number' ? signal.stopLoss : null,
        tp: typeof signal.takeProfit === 'number' ? signal.takeProfit : null,
        confidence: typeof signal.confidence === 'number' ? signal.confidence : null,
        recommendation: typeof signal.rrTier === 'string' ? signal.rrTier : null,
        reason: reasonStr,
        rawPayload: {
          executionSource: 'recent_signals_v3',
          refreshedBeforeExecution: trade.refreshPerformed === true,
          signal,
          trade,
        },
        edge: opened ? edgeSnapshotFromSignal(signal) : null,
      });
    },
  });
}
