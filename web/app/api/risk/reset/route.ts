import { callScannerForCurrentUser } from '@/lib/scannerProxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Reset only the authenticated user's active broker account daily-loss baseline.
 * The scanner immediately re-seeds the baseline from the broker's current balance.
 */
export async function POST() {
  return callScannerForCurrentUser({
    internalPath: '/api/internal/oanda/risk-reset',
    logTag: 'RISK_RESET',
    payloadKey: 'risk',
  });
}
