import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { resolveActiveBrokerForUser } from '@/lib/brokerResolver';
import {
  getSignalLearningDashboard,
  refreshPairPlaybooksForAccount,
} from '@/lib/signalLearning';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ENGINES = ['v3', 'ict', 'ppr'] as const;
type Engine = typeof ENGINES[number];

function normalizeEngine(value: unknown): Engine | null {
  const engine = String(value || '').toLowerCase();
  return ENGINES.includes(engine as Engine) ? engine as Engine : null;
}

async function accountContext(userId: string) {
  const resolved = await resolveActiveBrokerForUser(userId);
  if (resolved.brokerCredentialStatus !== 'ready' || !resolved.getCredentials) {
    return { ok: false as const, error: resolved.reason, status: 409 };
  }
  const credentials = await resolved.getCredentials();
  if (!credentials?.accountId) {
    return { ok: false as const, error: 'Broker account credentials could not be resolved.', status: 409 };
  }
  return {
    ok: true as const,
    accountId: credentials.accountId,
    environment: resolved.activeEnvironment,
  };
}

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ ok: false, error: 'Unauthenticated' }, { status: 401 });

  try {
    const context = await accountContext(userId);
    if (!context.ok) return NextResponse.json({ ok: false, error: context.error }, { status: context.status });
    const url = new URL(req.url);
    const engine = normalizeEngine(url.searchParams.get('engine'));
    const dashboard = await getSignalLearningDashboard({
      userId,
      brokerAccountId: context.accountId,
      engine,
    });
    return NextResponse.json({
      ok: true,
      accountScoped: true,
      environment: context.environment,
      engine,
      ...dashboard,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const migrationRequired = /signal_observations|pair_ai_playbooks|pair_summary_stats/i.test(message);
    console.error('[SIGNAL_LEARNING_API] read failed:', message);
    return NextResponse.json({ ok: false, error: message, migrationRequired }, { status: migrationRequired ? 503 : 500 });
  }
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ ok: false, error: 'Unauthenticated' }, { status: 401 });

  try {
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch {}
    const requested = normalizeEngine(body.engine);
    const engines: Engine[] = requested ? [requested] : [...ENGINES];
    const context = await accountContext(userId);
    if (!context.ok) return NextResponse.json({ ok: false, error: context.error }, { status: context.status });

    const results = [];
    for (const engine of engines) {
      results.push({
        engine,
        ...(await refreshPairPlaybooksForAccount({
          userId,
          brokerAccountId: context.accountId,
          engine,
        })),
      });
    }

    return NextResponse.json({
      ok: results.every((result) => result.ok),
      accountScoped: true,
      environment: context.environment,
      results,
      liveThresholdsChanged: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[SIGNAL_LEARNING_API] refresh failed:', message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
