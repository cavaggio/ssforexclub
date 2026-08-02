/**
 * Authenticated FTMO MetaTrader 5 bridge proxy.
 *
 * Credentials are resolved from the signed-in user's encrypted FTMO connection
 * and forwarded server-to-server to Railway. They are never returned to the
 * browser and can never fall through to an OANDA client.
 */

import { NextResponse } from 'next/server';
import { callFuturesProvider } from '@/lib/futuresProxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ALLOWED = new Set(['validate', 'diagnostics', 'status', 'trade', 'close']);

type FtmoOp = 'validate' | 'diagnostics' | 'status' | 'trade' | 'close';

export async function POST(req: Request, ctx: { params: Promise<{ op: string }> }) {
  const { op } = await ctx.params;
  if (!ALLOWED.has(op)) {
    return NextResponse.json({ ok: false, error: `Unknown operation "${op}"` }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const extraBody: Record<string, unknown> = {};

  if (op === 'trade') extraBody.order = body.order ?? {};
  if (op === 'close') extraBody.position = body.position ?? {};
  if (typeof body.accountId === 'string') extraBody.accountId = body.accountId;

  return callFuturesProvider({
    provider: 'ftmo',
    op: op as FtmoOp,
    extraBody,
  });
}
