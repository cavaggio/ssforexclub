/**
 * web/app/api/ict/analyze/route.ts
 *
 * ICT Intelligence — analyse all configured pairs. Authenticated; forwards to
 * the Railway scanner's internal ICT endpoint with the current user's broker
 * credentials (same proxy path as the scanner). Read-only / shadow: it never
 * trades. Returns the ICT analysis under `ict`.
 */

import { callScannerForCurrentUser } from '@/lib/scannerProxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  return callScannerForCurrentUser({
    internalPath: '/api/internal/oanda/ict',
    logTag: 'ICT_ANALYZE',
    payloadKey: 'ict',
  });
}
