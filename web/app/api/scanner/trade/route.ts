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
  });
}
