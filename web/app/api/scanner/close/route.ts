/**
 * web/app/api/scanner/close/route.ts
 *
 * Authenticated, per-user close-trade endpoint. Validates the close request
 * (tradeId required, units optional and positive when present), then forwards
 * to Railway's internal /api/internal/oanda/close with the caller's
 * decrypted broker credentials.
 *
 * Hard-fails (409) when:
 *   - Clerk session missing (401)
 *   - brokerCredentialStatus !== 'ready' — covers no_credentials,
 *     live_not_acknowledged, live_blocked_by_platform
 *
 * Never falls back to platform defaults. Never reaches Railway's public
 * /api/oanda/* endpoints. The user's token never touches the browser.
 *
 * Response:
 *   { ok: true, action: 'closed' | 'partial_closed', instrument, unitsClosed,
 *     brokerOrderId, pnl, message }
 *
 * The proxy unwraps the internal endpoint's body into a top-level `close`
 * key (per the shared scannerProxy convention) — the UI reads `json.close`.
 */

import { NextResponse } from 'next/server';
import { callScannerForCurrentUser } from '@/lib/scannerProxy';
import { logTradeEvent } from '@/lib/tradeLogs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type CloseInput = {
  tradeId?: unknown;
  instrument?: unknown;
  units?: unknown;
};

function validate(raw: unknown): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Body must be JSON' };
  const r = raw as CloseInput;
  if (typeof r.tradeId !== 'string' || r.tradeId.trim() === '') {
    return { ok: false, error: 'Missing tradeId' };
  }
  if (r.instrument != null && typeof r.instrument !== 'string') {
    return { ok: false, error: 'instrument must be a string when provided' };
  }
  if (r.units != null) {
    if (typeof r.units === 'string' && r.units.toUpperCase() === 'ALL') {
      // ok
    } else {
      const n = Number(r.units);
      if (!Number.isFinite(n) || n <= 0) {
        return { ok: false, error: 'units must be ALL or a positive number' };
      }
    }
  }
  return {
    ok: true,
    body: {
      tradeId: r.tradeId,
      instrument: r.instrument ?? null,
      units: r.units ?? 'ALL',
    },
  };
}

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Body must be JSON' }, { status: 400 });
  }
  const v = validate(raw);
  if (!v.ok) {
    return NextResponse.json({ ok: false, error: v.error }, { status: 400 });
  }
  return callScannerForCurrentUser({
    internalPath: '/api/internal/oanda/close',
    logTag: 'SCANNER_CLOSE',
    payloadKey: 'close',
    extraBody: v.body,
    afterCall: async (ctx, result) => {
      // Treat the close response as the payload — closeBrokerTrade returns
      // { ok, action, instrument, tradeId, unitsClosed, brokerOrderId, pnl,
      //   message, error?, raw? } either way. Log either manual_close_executed
      // (full) / partial_closed (partial) on success, or error on failure.
      const close = (result.data ?? {}) as Record<string, unknown>;
      const isPartial = close.action === 'partial_closed' || (v.body.units !== 'ALL');
      const pnl = typeof close.pnl === 'number' ? close.pnl : null;
      const instrument = typeof v.body.instrument === 'string' ? v.body.instrument : null;
      await logTradeEvent({
        userId: ctx.userId,
        broker: ctx.broker,
        brokerAccountId: ctx.brokerAccountId,
        environment: ctx.environment,
        eventType: result.ok
          ? isPartial
            ? 'partial_closed'
            : 'manual_close_executed'
          : 'error',
        instrument,
        tradeId: typeof v.body.tradeId === 'string' ? v.body.tradeId : null,
        brokerOrderId: typeof close.brokerOrderId === 'string' ? close.brokerOrderId : null,
        unitsClosed: typeof close.unitsClosed === 'number' ? close.unitsClosed : null,
        realizedPL: pnl,
        reason: typeof close.message === 'string'
          ? close.message
          : result.ok ? null : result.error ?? null,
        rawPayload: { close, requestedUnits: v.body.units },
        // V3 Edge Intelligence — realised outcome of the closed trade. Entry-
        // condition fields were captured on the 'opened' event; here we record
        // pair / exit-time / pnl / win-loss so closed trades carry an outcome.
        edge: result.ok
          ? {
              pair: instrument,
              exitTime: new Date().toISOString(),
              pnl,
              winLoss: pnl == null ? null : pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven',
            }
          : null,
      });
    },
  });
}
