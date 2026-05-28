/**
 * web/app/api/scanner/active-trades/analysis/route.ts
 *
 * Authenticated, per-user active-trade reassessment endpoint. Calls Railway's
 * internal `/api/internal/oanda/active-trades/analysis` with credentials
 * resolved from the current user's broker connection. Hard-fails (409) when
 * no usable credentials exist — never falls back to platform defaults.
 */

import { callScannerForCurrentUser } from '@/lib/scannerProxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  return callScannerForCurrentUser({
    internalPath: '/api/internal/oanda/active-trades/analysis',
    logTag: 'SCANNER_ANALYSIS',
    payloadKey: 'analysis',
  });
}
