/**
 * web/app/api/scanner/trade/route.ts
 *
 * Authenticated, per-user trade execution endpoint. Forwards a validated
 * signal to Railway's internal `/api/internal/oanda/trade` with the caller's
 * decrypted broker credentials. Hard-fails when:
 *
 *   - Clerk session missing (401)
 *   - No usable credentials for the selected mode (409)
 *   - activeEnvironment is not 'live' (409) — trades only run in live mode
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
  [k: string]: unknown;
};

function validateSignal(raw: unknown): { ok: true; signal: Record<string, unknown> } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'Missing signal in request body' };
  }
  const s = raw as SignalInput;
  if (typeof s.pair !== 'string' || !/^[A-Z]{3}_[A-Z]{3}$/.test(s.pair)) {
    return { ok: false, error: 'Invalid signal.pair (expected e.g. EUR_USD)' };
  }
  if (s.direction !== 'long' && s.direction !== 'short') {
    return { ok: false, error: 'Invalid signal.direction (must be long or short)' };
  }
  return { ok: true, signal: s as Record<string, unknown> };
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
    internalPath: '/api/internal/oanda/trade',
    logTag: 'SCANNER_TRADE',
    payloadKey: 'trade',
    requireLive: true,
    extraBody: { signal: validated.signal },
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
        rawPayload: { signal, trade },
        // V3 Edge Intelligence — capture the conditions this trade was opened
        // under. Entry-time fields only; pnl/exit are filled on the close event.
        edge: opened ? edgeSnapshotFromSignal(signal) : null,
      });
    },
  });
}
