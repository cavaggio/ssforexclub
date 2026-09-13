import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getUserTradingSettings, platformLiveTradingEnabled } from '@/lib/userTradingSettings';
import { getAutoClosePreference, setAutoClosePreference } from '@/lib/autoCloseSettings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ ok: false, error: 'Unauthenticated' }, { status: 401 });

  try {
    const [preference, settings] = await Promise.all([
      getAutoClosePreference(userId),
      getUserTradingSettings(userId),
    ]);
    const ftmoHardPolicy = settings.activeBroker === 'ftmo';
    return NextResponse.json({
      ok: true,
      autoCloseEnabled: ftmoHardPolicy ? true : preference.enabled,
      migrationRequired: preference.migrationRequired,
      platformLiveTradingEnabled: platformLiveTradingEnabled(),
      liveTradingAcknowledged: settings.liveTradingAcknowledged,
      activeEnvironment: settings.activeEnvironment,
      activeBroker: settings.activeBroker,
      ftmoHardPolicy,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ ok: false, error: 'Unauthenticated' }, { status: 401 });

  let body: { enabled?: unknown };
  try {
    body = await req.json() as { enabled?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: 'Body must be JSON' }, { status: 400 });
  }

  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json({ ok: false, error: 'enabled must be a boolean' }, { status: 400 });
  }

  try {
    const settings = await getUserTradingSettings(userId);
    if (settings.activeBroker === 'ftmo') {
      if (body.enabled === false) {
        return NextResponse.json({
          ok: false,
          error: 'FTMO broker-side profit protection is mandatory and cannot be disabled while FTMO is the active execution account.',
        }, { status: 409 });
      }
      await setAutoClosePreference(userId, true);
      return NextResponse.json({
        ok: true,
        autoCloseEnabled: true,
        migrationRequired: false,
        ftmoHardPolicy: true,
      });
    }

    const preference = await setAutoClosePreference(userId, body.enabled);
    return NextResponse.json({
      ok: true,
      autoCloseEnabled: preference.enabled,
      migrationRequired: false,
      ftmoHardPolicy: false,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}
