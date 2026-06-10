/**
 * web/app/api/risk/status/route.ts
 *
 * Authenticated, read-only risk snapshot for the dashboard Risk Management
 * panel. Forwards to the Railway scanner's internal risk-status endpoint with
 * the current user's broker credentials and returns the central risk-manager
 * state (per-trade cap, daily drawdown lock, auto-execution threshold) under
 * `risk`. Never places or changes a trade.
 */

import { callScannerForCurrentUser } from '@/lib/scannerProxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  return callScannerForCurrentUser({
    internalPath: '/api/internal/oanda/risk-status',
    logTag: 'RISK_STATUS',
    payloadKey: 'risk',
  });
}
