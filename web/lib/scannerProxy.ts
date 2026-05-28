/**
 * web/lib/scannerProxy.ts
 *
 * Shared helper for the authenticated /api/scanner/* routes. Each route:
 *   1. Authenticates the request via Clerk.
 *   2. Resolves the current user's active broker connection (decrypted
 *      credentials, environment, baseUrl).
 *   3. Hard-fails (409) if no usable credentials exist for the chosen mode —
 *      no silent fallback to platform defaults.
 *   4. Forwards a server-to-server request to the Railway scanner's internal
 *      endpoint with the credentials in the body and a shared secret in the
 *      X-Internal-Auth header.
 *   5. Wraps the scanner payload with active-mode metadata for the dashboard.
 *
 * The token never leaves the server. The browser never sees Railway's URL.
 *
 * Structured logs are emitted on every call (clerkUserId, broker, env, masked
 * accountId, usingDefaultClient: false). Tokens are never logged.
 */
import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { resolveActiveBrokerForUser } from '@/lib/brokerResolver';

const SCANNER_BASE_URL = process.env.SCANNER_BASE_URL || 'http://localhost:3001';

function maskAccountId(accountId: string | null | undefined): string {
  if (!accountId) return '<none>';
  if (accountId.length <= 4) return '***';
  return `${accountId.slice(0, 3)}…${accountId.slice(-3)}`;
}

type InternalCallResult =
  | { ok: true; data: unknown }
  | { ok: false; status: number; error: string };

async function callInternalEndpoint(
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
      headers: { 'Content-Type': 'application/json', 'X-Internal-Auth': secret },
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

/**
 * Resolve the current user's broker credentials, forward a server-to-server
 * request to the given internal scanner path, and return a normalized response
 * envelope keyed by `payloadKey` (e.g. 'scan', 'analysis', 'reassessment').
 *
 * Always hard-fails when no per-user credentials are available. Logs every
 * call with masked identifiers — never tokens.
 */
export async function callScannerForCurrentUser(args: {
  internalPath: string;
  logTag: string;
  payloadKey: 'scan' | 'analysis' | 'reassessment';
  extraBody?: Record<string, unknown>;
}): Promise<NextResponse> {
  const { internalPath, logTag, payloadKey, extraBody = {} } = args;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated' }, { status: 401 });
  }

  const resolved = await resolveActiveBrokerForUser(userId);
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
  });

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    ok: true,
    activeBroker: resolved.activeBroker,
    activeEnvironment: resolved.activeEnvironment,
    isLiveTrading: resolved.isLiveTrading,
    isPaperTrading: resolved.isPaperTrading,
    [payloadKey]: result.data,
  });
}
