/**
 * web/lib/futuresProxy.ts
 *
 * Authenticated proxy for the futures providers, kept entirely separate from
 * the OANDA scanner proxy (web/lib/scannerProxy.ts). A futures route resolves
 * ONLY its own provider's active connection, decrypts the credential blob
 * server-side, and forwards it to the matching /api/internal/<provider>/*
 * endpoint. The scanner additionally asserts the provider, so a futures trade
 * physically cannot reach the OANDA client.
 *
 * The decrypted credentials never appear in the NextResponse — only the
 * sanitized scanner payload (accounts/positions/order result) is returned.
 */

import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { callInternalEndpoint } from './scannerProxy';
import {
  listFuturesConnections,
  resolveFuturesCredentials,
  type FuturesProvider,
} from './futuresProvider';

type Op = 'validate' | 'status' | 'trade' | 'close';

/**
 * Resolve the user's active connection for `provider`, forward to the internal
 * futures endpoint, and return a sanitized envelope. `extraBody` carries op
 * params (order/position/accountId) — never credentials.
 */
export async function callFuturesProvider(args: {
  provider: FuturesProvider;
  op: Op;
  extraBody?: Record<string, unknown>;
}): Promise<NextResponse> {
  const { provider, op, extraBody = {} } = args;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated' }, { status: 401 });
  }

  const connections = await listFuturesConnections(userId, provider);
  if (connections.length === 0) {
    return NextResponse.json(
      { ok: false, error: `No ${provider} account connected`, connectionStatus: 'not_connected' },
      { status: 409 },
    );
  }
  // Most-recent active connection for this provider (list is newest-first).
  const conn = connections[0];
  const resolved = await resolveFuturesCredentials(userId, conn.id);
  if (!resolved) {
    return NextResponse.json(
      { ok: false, error: 'Could not decrypt futures credentials', connectionStatus: 'decrypt_failed' },
      { status: 500 },
    );
  }

  console.log(
    `[FUTURES ${provider.toUpperCase()} ${op}] clerkUserId=${userId} env=${resolved.environment} ` +
      `connection=${conn.id} usingDefaultClient=false`,
  );

  const result = await callInternalEndpoint(`/api/internal/${provider}/${op}`, {
    // Provider tag is asserted server-side against the route — defense in depth.
    provider,
    credentials: resolved.credentials,
    environment: resolved.environment,
    accountId: resolved.accountId,
    ...extraBody,
  });

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }

  // result.data is the scanner payload — it never contains credentials.
  return NextResponse.json({
    ok: true,
    provider,
    environment: resolved.environment,
    ...(result.data && typeof result.data === 'object' ? result.data : { data: result.data }),
  });
}
