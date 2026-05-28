/**
 * web/app/api/scanner/scan/route.ts
 *
 * Authenticated, per-user scanner endpoint. Calls the Railway scanner's
 * internal `/api/internal/oanda/scan` with credentials resolved from the
 * current user's broker connection. Hard-fails (409) when no usable
 * credentials exist — never falls back to platform defaults.
 *
 * Browser fetches this route with a relative URL; Railway's URL never
 * reaches the client.
 */

import { callScannerForCurrentUser } from '@/lib/scannerProxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type ScanRequestBody = { pairs?: string[] };

async function handle(req: Request) {
  let body: ScanRequestBody = {};
  try {
    body = (await req.json()) as ScanRequestBody;
  } catch {
    /* empty body is fine */
  }
  return callScannerForCurrentUser({
    internalPath: '/api/internal/oanda/scan',
    logTag: 'SCANNER_SCAN',
    payloadKey: 'scan',
    extraBody: { pairs: Array.isArray(body.pairs) ? body.pairs : undefined },
  });
}

export async function POST(req: Request) {
  return handle(req);
}
