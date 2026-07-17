/**
 * web/app/api/user/auto-ai-trading/route.ts
 *
 * Clerk-scoped Auto AI preference. Exactly one engine is persisted per user.
 */

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getUserTradingSettings, setAutoAiTrading, platformLiveTradingEnabled } from '@/lib/userTradingSettings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type AutoAiEngine = 'ict' | 'v3' | 'ppr';

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ ok: false, error: 'Unauthenticated' }, { status: 401 });
  try {
    const settings = await getUserTradingSettings(userId);
    return NextResponse.json({
      ok: true,
      autoAiTradingEnabled: settings.autoAiTradingEnabled,
      autoAiEngine: settings.autoAiEngine,
      platformLiveTradingEnabled: platformLiveTradingEnabled(),
      liveTradingAcknowledged: settings.liveTradingAcknowledged,
      activeEnvironment: settings.activeEnvironment,
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

  let engine: AutoAiEngine | undefined;
  if (body.engine !== undefined) {
    if (body.engine !== 'ict' && body.engine !== 'v3' && body.engine !== 'ppr') {
      return NextResponse.json({ ok: false, error: "engine must be 'ict', 'v3', or 'ppr'" }, { status: 400 });
    }
    engine = body.engine;
  }

  try {
    const settings = await setAutoAiTrading(userId, body.enabled, engine);
    return NextResponse.json({
      ok: true,
      autoAiTradingEnabled: settings.autoAiTradingEnabled,
      autoAiEngine: settings.autoAiEngine,
      platformLiveTradingEnabled: platformLiveTradingEnabled(),
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
