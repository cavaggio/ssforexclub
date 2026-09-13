/**
 * web/lib/scannerProxy.ts
 *
 * Shared helper for the authenticated /api/scanner/* routes.
 *
 * Analysis and execution are intentionally separated:
 *   - OANDA/Alpaca active modes may use their active broker credentials.
 *   - FTMO uses MT5 EA for execution, but the scanner may use a separately
 *     saved/validated OANDA connection strictly as a market-data source.
 *   - FTMO analysis never falls through to OANDA execution. `analysisOnly`
 *     forces autoExecute=false and preserves FTMO as the active broker in the
 *     response envelope.
 */
import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { resolveActiveBrokerForUser } from '@/lib/brokerResolver';
import {
  getDecryptedBrokerCredentials,
  listBrokerConnectionsForUser,
  resolveBrokerBaseUrl,
} from '@/lib/brokerConnections';

const SCANNER_BASE_URL = process.env.SCANNER_BASE_URL || 'http://localhost:3001';

function maskAccountId(accountId: string | null | undefined): string {
  if (!accountId) return '<none>';
  if (accountId.length <= 4) return '***';
  return `${accountId.slice(0, 3)}…${accountId.slice(-3)}`;
}

type InternalCallResult =
  | { ok: true; data: unknown }
  | { ok: false; status: number; error: string };

export async function callInternalEndpoint(
  path: string,
  body: Record<string, unknown>,
): Promise<InternalCallResult> {
  const secret = process.env.SCANNER_INTERNAL_SECRET;
  if (!secret) {
    return {
      ok: false,
      status: 500,
      error: 'SCANNER_INTERNAL_SECRET not configured on the Next.js side',
    };
  }

  let res: Response;
  try {
    res = await fetch(`${SCANNER_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Auth': secret,
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: `Scanner unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* keep null */
  }

  if (!res.ok) {
    const detail =
      data && typeof data === 'object' && 'error' in (data as Record<string, unknown>)
        ? String((data as Record<string, unknown>).error)
        : text || '<empty>';
    return { ok: false, status: res.status, error: detail };
  }

  return { ok: true, data };
}

// Keep this context aligned with legacy scanner/trade logging callers. FTMO
// analysis does not invoke afterCall hooks; FTMO execution/logging has its own
// dedicated MT5 path.
export type AfterCallContext = {
  userId: string;
  broker: 'oanda' | 'alpaca';
  environment: 'practice' | 'live' | 'paper';
  brokerAccountId: string | null;
  isLiveTrading: boolean;
};

type MarketDataCredentials = {
  token: string;
  accountId: string;
  baseUrl: string;
  environment: 'practice' | 'live';
  connectionId: string;
};

/**
 * Resolve a dedicated FX market-data connection for FTMO analysis.
 *
 * This does NOT change the user's active execution broker and is never used by
 * trade/close routes. Practice is preferred because the scanner only needs
 * candles/pricing and there is no reason to route analysis through a live
 * OANDA account when a validated practice connection exists.
 */
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
      connectionId: connection.id,
    };
  }

  return null;
}

export async function callScannerForCurrentUser(args: {
  internalPath: string;
  logTag: string;
  payloadKey: 'scan' | 'analysis' | 'reassessment' | 'trade' | 'calibration' | 'close' | 'ict' | 'risk';
  extraBody?: Record<string, unknown>;
  requireLive?: boolean;
  skipCredentials?: boolean;
  /**
   * Read-only market analysis. When FTMO is active this permits the scanner to
   * use a separately validated OANDA connection as market-data transport while
   * keeping MT5 EA as the only execution transport.
   */
  analysisOnly?: boolean;
  afterCall?: (
    ctx: AfterCallContext,
    result: { ok: boolean; data: unknown; error?: string },
  ) => Promise<void> | void;
}): Promise<NextResponse> {
  const {
    internalPath,
    logTag,
    payloadKey,
    extraBody = {},
    requireLive = false,
    skipCredentials = false,
    analysisOnly = false,
    afterCall,
  } = args;

  const runAfterCall = async (
    ctx: AfterCallContext,
    result: { ok: boolean; data: unknown; error?: string },
  ) => {
    if (!afterCall) return;
    try {
      await afterCall(ctx, result);
    } catch (err) {
      console.warn(`[${logTag}] afterCall hook failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated' }, { status: 401 });
  }

  if (skipCredentials) {
    console.log(`[${logTag}] clerkUserId=${userId} skipCredentials=true`);
    const result = await callInternalEndpoint(internalPath, { ...extraBody });
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    }
    return NextResponse.json({
      ok: true,
      [payloadKey]: result.data,
    });
  }

  const resolved = await resolveActiveBrokerForUser(userId);

  // FTMO analysis path: execution remains MT5-only, while OANDA is explicitly
  // used as market-data transport for candles/pricing. This is not an execution
  // fallback. autoExecute is hard-disabled here regardless of caller input.
  if (
    analysisOnly &&
    resolved.activeBroker === 'ftmo' &&
    resolved.executionTransport === 'mt5_ea' &&
    resolved.brokerCredentialStatus === 'ready'
  ) {
    const marketData = await resolveFtmoMarketDataCredentials(userId);
    if (!marketData) {
      return NextResponse.json(
        {
          ok: false,
          error: 'FTMO is connected, but no validated OANDA market-data connection is available for scanner candles/pricing.',
          brokerCredentialStatus: 'market_data_unavailable',
          activeBroker: 'ftmo',
          activeEnvironment: resolved.activeEnvironment,
          executionTransport: 'mt5_ea',
        },
        { status: 409 },
      );
    }

    console.log(
      `[${logTag}] clerkUserId=${userId} executionBroker=ftmo executionTransport=mt5_ea ` +
      `marketDataBroker=oanda marketDataEnv=${marketData.environment} ` +
      `marketDataAccount=${maskAccountId(marketData.accountId)} analysisOnly=true`,
    );

    const result = await callInternalEndpoint(internalPath, {
      apiKey: marketData.token,
      accountId: marketData.accountId,
      baseUrl: marketData.baseUrl,
      environment: marketData.environment,
      ...extraBody,
      autoExecute: false,
      analysisOnly: true,
      executionBroker: 'ftmo',
      executionTransport: 'mt5_ea',
      userId,
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: result.error,
          activeBroker: 'ftmo',
          activeEnvironment: resolved.activeEnvironment,
          executionTransport: 'mt5_ea',
          marketDataBroker: 'oanda',
          marketDataEnvironment: marketData.environment,
        },
        { status: result.status },
      );
    }

    return NextResponse.json({
      ok: true,
      activeBroker: 'ftmo',
      activeEnvironment: resolved.activeEnvironment,
      isLiveTrading: resolved.isLiveTrading,
      isPaperTrading: resolved.isPaperTrading,
      executionTransport: 'mt5_ea',
      marketDataBroker: 'oanda',
      marketDataEnvironment: marketData.environment,
      [payloadKey]: result.data,
    });
  }

  if (
    resolved.brokerCredentialStatus !== 'ready' ||
    !resolved.getCredentials ||
    !resolved.baseUrl
  ) {
    console.warn(
      `[${logTag}] hard-fail clerkUserId=${userId} broker=${resolved.activeBroker ?? '<none>'} ` +
        `env=${resolved.activeEnvironment ?? '<none>'} status=${resolved.brokerCredentialStatus} ` +
        `reason="${resolved.reason}"`,
    );
    return NextResponse.json(
      {
        ok: false,
        error: resolved.reason,
        brokerCredentialStatus: resolved.brokerCredentialStatus,
        activeEnvironment: resolved.activeEnvironment,
        activeBroker: resolved.activeBroker,
      },
      { status: 409 },
    );
  }

  if (requireLive && resolved.activeEnvironment !== 'live') {
    console.warn(
      `[${logTag}] hard-fail clerkUserId=${userId} status=not_live ` +
        `activeEnvironment=${resolved.activeEnvironment} — refusing trade execution`,
    );
    return NextResponse.json(
      {
        ok: false,
        error: 'Trade execution requires live mode. Switch to OANDA Live in Settings before executing trades.',
        brokerCredentialStatus: 'not_live',
        activeEnvironment: resolved.activeEnvironment,
        activeBroker: resolved.activeBroker,
      },
      { status: 409 },
    );
  }

  const creds = await resolved.getCredentials();
  if (!creds) {
    console.error(
      `[${logTag}] decrypt-fail clerkUserId=${userId} broker=${resolved.activeBroker} env=${resolved.activeEnvironment}`,
    );
    return NextResponse.json(
      { ok: false, error: 'Could not decrypt broker credentials' },
      { status: 500 },
    );
  }

  console.log(
    `[${logTag}] clerkUserId=${userId} broker=${resolved.activeBroker} ` +
      `env=${resolved.activeEnvironment} accountId=${maskAccountId(creds.accountId)} ` +
      `usingDefaultClient=false`,
  );

  const result = await callInternalEndpoint(internalPath, {
    apiKey: creds.token,
    accountId: creds.accountId,
    baseUrl: resolved.baseUrl,
    environment: resolved.activeEnvironment,
    ...extraBody,
    userId,
  });

  const afterCtx: AfterCallContext = {
    userId,
    broker: (resolved.activeBroker ?? 'oanda') as 'oanda' | 'alpaca',
    environment: resolved.activeEnvironment as 'practice' | 'live' | 'paper',
    brokerAccountId: creds.accountId,
    isLiveTrading: resolved.isLiveTrading,
  };

  if (!result.ok) {
    await runAfterCall(afterCtx, { ok: false, data: null, error: result.error });
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }

  await runAfterCall(afterCtx, { ok: true, data: result.data });

  return NextResponse.json({
    ok: true,
    activeBroker: resolved.activeBroker,
    activeEnvironment: resolved.activeEnvironment,
    isLiveTrading: resolved.isLiveTrading,
    isPaperTrading: resolved.isPaperTrading,
    [payloadKey]: result.data,
  });
}
