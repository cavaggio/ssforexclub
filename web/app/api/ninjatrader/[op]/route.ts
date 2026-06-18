/**
 * web/app/api/ninjatrader/[op]/route.ts
 *
 * Authenticated NinjaTrader futures proxy. op ∈ { validate, status, trade, close }.
 * Separate from /api/scanner/* (OANDA) — futures never share the forex path.
 * The route forwards op params only; credentials are resolved + decrypted
 * server-side by callFuturesProvider and never returned to the browser.
 */

import { NextResponse } from 'next/server';
import { callFuturesProvider } from '@/lib/futuresProxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ALLOWED = new Set(['validate', 'diagnostics', 'status', 'trade', 'close']);

export async function POST(req: Request, ctx: { params: Promise<{ op: string }> }) {
  const { op } = await ctx.params;
  if (!ALLOWED.has(op)) {
    return NextResponse.json({ ok: false, error: `Unknown operation "${op}"` }, { status: 404 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const extraBody: Record<string, unknown> = {};
  if (op === 'trade') extraBody.order = body.order ?? {};
  if (op === 'close') extraBody.position = body.position ?? {};
  if (typeof body.accountId === 'string') extraBody.accountId = body.accountId;

  return callFuturesProvider({ provider: 'ninjatrader', op: op as 'validate' | 'diagnostics' | 'status' | 'trade' | 'close', extraBody });
}
