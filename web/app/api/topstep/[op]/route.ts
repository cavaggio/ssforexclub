/**
 * web/app/api/topstep/[op]/route.ts
 *
 * Authenticated Topstep proxy. op ∈ { validate, status, trade, close }.
 * Separate from OANDA and NinjaTrader. Live execution is blocked server-side by
 * the Topstep connector's compliance gate (TOPSTEP_CLOUD_EXECUTION_ALLOWED);
 * trade/close ops still route here but return a blocked result with the
 * compliance message until the gate is opened.
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

  return callFuturesProvider({ provider: 'topstep', op: op as 'validate' | 'diagnostics' | 'status' | 'trade' | 'close', extraBody });
}
