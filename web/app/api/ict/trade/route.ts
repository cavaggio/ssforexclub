/**
 * web/app/api/ict/trade/route.ts
 *
 * Manual ICT trade execution. Authenticated; forwards to Railway's internal
 * ICT trade endpoint with the caller's decrypted per-user OANDA credentials.
 * Hard-fails when not in live mode (requireLive) — never falls back to platform
 * credentials. The server-side executor enforces the ICT flags (off by default),
 * the live-trading acknowledgement, a server-side signal recompute, and the
 * shared duplicate lock. Isolated from V3 execution.
 */

import { NextResponse } from 'next/server';
import { callScannerForCurrentUser } from '@/lib/scannerProxy';
import { logTradeEvent } from '@/lib/tradeLogs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type IctTradeBody = {
  pair?: unknown;
  direction?: unknown;
  units?: unknown;
  entry?: unknown;
  stopLoss?: unknown;
  targetProfit?: unknown;
  ictSignalId?: unknown;
};

function validate(b: IctTradeBody): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  if (typeof b.pair !== 'string' || !/^[A-Z]{3}_[A-Z]{3}$/.test(b.pair)) return { ok: false, error: 'Invalid pair (e.g. EUR_USD)' };
  if (b.direction !== 'long' && b.direction !== 'short') return { ok: false, error: 'Invalid direction (long|short)' };
  for (const k of ['entry', 'stopLoss', 'targetProfit'] as const) {
    if (typeof b[k] !== 'number' || !Number.isFinite(b[k] as number)) return { ok: false, error: `Invalid ${k} (must be a number)` };
  }
  if (typeof b.ictSignalId !== 'string' || !b.ictSignalId) return { ok: false, error: 'Missing ictSignalId' };
  return {
    ok: true,
    payload: {
      pair: b.pair, direction: b.direction,
      units: typeof b.units === 'number' ? b.units : 0, // advisory only; server sizes authoritatively
      entry: b.entry, stopLoss: b.stopLoss, targetProfit: b.targetProfit, ictSignalId: b.ictSignalId,
    },
  };
}

export async function POST(req: Request) {
  let body: IctTradeBody = {};
  try {
    body = (await req.json()) as IctTradeBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'Body must be JSON' }, { status: 400 });
  }
  const v = validate(body);
  if (!v.ok) return NextResponse.json({ ok: false, error: v.error }, { status: 400 });

  return callScannerForCurrentUser({
    internalPath: '/api/internal/oanda/ict/trade',
    logTag: 'ICT_TRADE',
    payloadKey: 'ict',
    requireLive: true,
    extraBody: v.payload,
    afterCall: async (ctx, result) => {
      const trade = (result.data ?? {}) as Record<string, unknown>;
      const opened = result.ok && trade.success === true;
      const reason = result.ok
        ? (typeof trade.reason === 'string' ? trade.reason : null)
        : (result.error ?? null);
      await logTradeEvent({
        userId: ctx.userId,
        broker: ctx.broker,
        brokerAccountId: ctx.brokerAccountId,
        environment: ctx.environment,
        eventType: opened ? 'opened' : 'error',
        instrument: typeof v.payload.pair === 'string' ? (v.payload.pair as string) : null,
        tradeId: typeof trade.tradeId === 'string' ? trade.tradeId : null,
        brokerOrderId: typeof trade.tradeId === 'string' ? trade.tradeId : null,
        side: v.payload.direction === 'long' || v.payload.direction === 'short' ? (v.payload.direction as 'long' | 'short') : null,
        units: typeof trade.units === 'number' ? Math.abs(trade.units) : null,
        entryPrice: typeof trade.fillPrice === 'number' ? trade.fillPrice : null,
        sl: typeof v.payload.stopLoss === 'number' ? (v.payload.stopLoss as number) : null,
        tp: typeof v.payload.targetProfit === 'number' ? (v.payload.targetProfit as number) : null,
        reason: reason ? `[ICT] ${reason}` : '[ICT] trade',
        rawPayload: { strategy: 'ICT', request: v.payload, result: trade },
      });
    },
  });
}
