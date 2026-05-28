/**
 * web/app/api/scanner/active-trades/reassess/route.ts
 *
 * Authenticated, per-user 30-min reassessment endpoint. Calls Railway's
 * internal `/api/internal/oanda/active-trades/reassess` with credentials
 * resolved from the current user's broker connection. Hard-fails (409) when
 * no usable credentials exist — never falls back to platform defaults.
 */

import { callScannerForCurrentUser } from '@/lib/scannerProxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  return callScannerForCurrentUser({
    internalPath: '/api/internal/oanda/active-trades/reassess',
    logTag: 'SCANNER_REASSESS',
    payloadKey: 'reassessment',
  });
}
