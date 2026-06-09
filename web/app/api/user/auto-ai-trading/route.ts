/**
 * web/app/api/user/auto-ai-trading/route.ts
 *
 * Per-user "Auto AI Trading" preference. Clerk-scoped — the user_id always
 * comes from the session, never the client. GET returns the user's flag plus
 * the platform upper-gate; POST persists the flag. This controls AI
 * AUTO-trading only (not manual execution), and is the source of truth the
 * Phase 2 scheduler will consume.
 */

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getUserTradingSettings, setAutoAiTrading, platformLiveTradingEnabled } from '@/lib/userTradingSettings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ ok: false, error: 'Unauthenticated' }, { status: 401 });
  try {
    const s = await getUserTradingSettings(userId);
    return NextResponse.json({
      ok: true,
      autoAiTradingEnabled: s.autoAiTradingEnabled,
      autoAiEngine: s.autoAiEngine,
      platformLiveTradingEnabled: platformLiveTradingEnabled(),
      liveTradingAcknowledged: s.liveTradingAcknowledged,
      activeEnvironment: s.activeEnvironment,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ ok: false, error: 'Unauthenticated' }, { status: 401 });
  let body: { enabled?: unknown; engine?: unknown } = {};
  try {
    body = (await req.json()) as { enabled?: unknown; engine?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: 'Body must be JSON' }, { status: 400 });
  }
  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json({ ok: false, error: 'enabled must be a boolean' }, { status: 400 });
  }
  let engine: 'ict' | 'v3' | undefined;
  if (body.engine !== undefined) {
    if (body.engine !== 'ict' && body.engine !== 'v3') {
      return NextResponse.json({ ok: false, error: "engine must be 'ict' or 'v3'" }, { status: 400 });
    }
    engine = body.engine;
  }
  try {
    const s = await setAutoAiTrading(userId, body.enabled, engine);
    return NextResponse.json({
      ok: true,
      autoAiTradingEnabled: s.autoAiTradingEnabled,
      autoAiEngine: s.autoAiEngine,
      platformLiveTradingEnabled: platformLiveTradingEnabled(),
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
