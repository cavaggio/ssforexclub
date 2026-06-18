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
 *
 * Transport failures (Railway unreachable, internal-auth mismatch, missing
 * secret) are mapped to stable codes — a raw "fetch failed" is never surfaced.
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
import { mapScannerTransportError, messageForCode } from './futuresStatus';

type Op = 'validate' | 'diagnostics' | 'status' | 'trade' | 'close';

function redactUser(userId: string): string {
  return userId.length <= 8 ? '***' : `${userId.slice(0, 5)}…${userId.slice(-3)}`;
}

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
    return NextResponse.json({ ok: false, code: 'UNAUTHENTICATED', message: 'Unauthenticated' }, { status: 401 });
  }

  const log = (msg: string) => console.log(`[FUTURES ${provider.toUpperCase()} ${op}] user=${redactUser(userId)} broker=${provider} ${msg}`);

  // ─── credential lookup ──────────────────────────────────────────────────
  const connections = await listFuturesConnections(userId, provider).catch(() => []);
  if (connections.length === 0) {
    log('savedCredentials=false → NO_CREDENTIALS');
    return NextResponse.json(
      { ok: false, code: 'NO_CREDENTIALS', message: messageForCode('NO_CREDENTIALS') },
      { status: 400 },
    );
  }
  const conn = connections[0]; // most-recent active connection for this provider
  const resolved = await resolveFuturesCredentials(userId, conn.id).catch(() => null);
  if (!resolved) {
    log('savedCredentials=true decrypt=failed → DECRYPT_FAILED');
    return NextResponse.json(
      { ok: false, code: 'DECRYPT_FAILED', message: 'Could not decrypt saved credentials.' },
      { status: 500 },
    );
  }

  const railwayConfigured = Boolean(process.env.SCANNER_BASE_URL);
  const secretConfigured = Boolean(process.env.SCANNER_INTERNAL_SECRET);
  log(
    `savedCredentials=true env=${resolved.environment} scannerUrl=${railwayConfigured ? 'present' : 'default-localhost'} ` +
    `internalSecret=${secretConfigured ? 'present' : 'MISSING'}`,
  );

  // ─── forward to the scanner ─────────────────────────────────────────────
  const result = await callInternalEndpoint(`/api/internal/${provider}/${op}`, {
    provider, // asserted server-side against the route
    credentials: resolved.credentials,
    environment: resolved.environment,
    accountId: resolved.accountId,
    ...extraBody,
  });

  if (!result.ok) {
    const { code, detail } = mapScannerTransportError(result);
    log(`scannerStatus=${result.status} → ${code}`);
    return NextResponse.json(
      { ok: false, code, message: messageForCode(code, detail) },
      { status: code === 'SCANNER_UNREACHABLE' ? 502 : code === 'INTERNAL_AUTH_FAILED' ? 502 : result.status || 500 },
    );
  }

  // result.data is the connector payload (its own ok/code) — never credentials.
  const data = result.data && typeof result.data === 'object' ? (result.data as Record<string, unknown>) : { data: result.data };
  log(`scannerStatus=200 code=${String(data.code ?? 'OK')}`);
  return NextResponse.json({ provider, ...data });
}
