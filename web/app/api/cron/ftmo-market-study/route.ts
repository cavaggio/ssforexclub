import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/db';
import { resolveActiveBrokerForUser } from '@/lib/brokerResolver';
import { callInternalEndpoint } from '@/lib/scannerProxy';
import {
  getDecryptedBrokerCredentials,
  listBrokerConnectionsForUser,
  resolveBrokerBaseUrl,
} from '@/lib/brokerConnections';
import { recordSignalLearningCycle } from '@/lib/signalLearning';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type StudyEngine = 'ict' | 'ppr';

type MarketDataCredentials = {
  token: string;
  accountId: string;
  baseUrl: string;
  environment: 'practice' | 'live';
};

function requestedEngine(value: unknown): StudyEngine | null {
  const engine = String(value || '').toLowerCase();
  return engine === 'ict' || engine === 'ppr' ? engine : null;
}

async function resolveFtmoMarketDataCredentials(userId: string): Promise<MarketDataCredentials | null> {
  const connections = await listBrokerConnectionsForUser(userId);
  const candidates = connections
    .filter((connection) =>
      connection.broker === 'oanda' &&
      connection.isActive &&
      connection.validationStatus === 'validated' &&
      (connection.environment === 'practice' || connection.environment === 'live'),
    )
    .sort((a, b) => {
      if (a.environment === b.environment) return 0;
      return a.environment === 'practice' ? -1 : 1;
    });

  for (const connection of candidates) {
    const credentials = await getDecryptedBrokerCredentials(userId, connection.id);
    if (!credentials || credentials.broker !== 'oanda') continue;
    if (credentials.environment !== 'practice' && credentials.environment !== 'live') continue;
    return {
      token: credentials.token,
      accountId: credentials.accountId,
      environment: credentials.environment,
      baseUrl: resolveBrokerBaseUrl('oanda', credentials.environment),
    };
  }

  return null;
}

export async function POST(req: Request) {
  const secret = process.env.AUTO_AI_CRON_SECRET;
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch {}

  const engine = requestedEngine(body.engine);
  if (!engine) {
    return NextResponse.json({ ok: false, error: 'FTMO market study requires engine ict or ppr.' }, { status: 400 });
  }

  const rootRunId = typeof body.runId === 'string'
    ? body.runId
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const source = typeof body.source === 'string' && body.source.trim()
    ? body.source.trim()
    : 'ftmo-market-study';

  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('user_trading_settings')
    .select('user_id')
    .eq('auto_ai_trading_enabled', true);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const results: Record<string, unknown>[] = [];
  let eligibleUsers = 0;
  let completedUsers = 0;
  let failedUsers = 0;
  let learningObservations = 0;
  let learningOutcomes = 0;

  for (const row of (data ?? []) as Array<{ user_id: string }>) {
    try {
      const resolved = await resolveActiveBrokerForUser(row.user_id);
      const isFtmoMt5 =
        resolved.activeBroker === 'ftmo' &&
        resolved.executionTransport === 'mt5_ea' &&
        resolved.brokerCredentialStatus === 'ready';
      if (!isFtmoMt5) continue;

      eligibleUsers += 1;
      const marketData = await resolveFtmoMarketDataCredentials(row.user_id);
      if (!marketData) {
        failedUsers += 1;
        results.push({
          user: row.user_id,
          engine,
          ok: false,
          reason: 'No validated OANDA market-data connection is available for FTMO study.',
        });
        continue;
      }

      const runId = `${rootRunId}-${engine}`;
      const response = await callInternalEndpoint('/api/internal/oanda/auto', {
        apiKey: marketData.token,
        accountId: marketData.accountId,
        baseUrl: marketData.baseUrl,
        environment: marketData.environment,
        userId: row.user_id,
        engine,
        runId,
        scanMode: 'daily_study',
        pairs: [],
        autoExecute: false,
        analysisOnly: true,
        executionBroker: 'ftmo',
        executionTransport: 'mt5_ea',
      });

      if (!response.ok) {
        failedUsers += 1;
        results.push({
          user: row.user_id,
          engine,
          marketDataAccountId: marketData.accountId,
          marketDataEnvironment: marketData.environment,
          ok: false,
          status: response.status,
          error: response.error,
        });
        continue;
      }

      const payload = (response.data ?? {}) as Record<string, any>;
      const learning = await recordSignalLearningCycle({
        userId: row.user_id,
        brokerAccountId: marketData.accountId,
        environment: marketData.environment,
        engine,
        scanMode: 'daily_study',
        runId,
        payload,
      });

      completedUsers += 1;
      learningObservations += learning.observationsWritten;
      learningOutcomes += learning.outcomesWritten;
      results.push({
        user: row.user_id,
        engine,
        marketDataAccountId: marketData.accountId,
        marketDataEnvironment: marketData.environment,
        ok: true,
        studyCount: Array.isArray(payload.studies) ? payload.studies.length : null,
        learningObservations: learning.observationsWritten,
        learningOutcomes: learning.outcomesWritten,
      });
    } catch (err) {
      failedUsers += 1;
      results.push({
        user: row.user_id,
        engine,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const ok = failedUsers === 0;
  console.log(
    `[FTMO_MARKET_STUDY][${engine.toUpperCase()}] source=${source} eligible=${eligibleUsers} ` +
    `completed=${completedUsers} failed=${failedUsers} learningObservations=${learningObservations}`,
  );

  return NextResponse.json({
    ok,
    source,
    engine,
    eligibleUsers,
    completedUsers,
    failedUsers,
    learningObservations,
    learningOutcomes,
    executionAllowed: false,
    results,
  }, { status: ok ? 200 : 500 });
}
