/**
 * ICT Intelligence — analyse all configured pairs.
 *
 * Read-only market analysis is independent from the selected execution broker.
 * When FTMO is active, scannerProxy uses a validated OANDA connection only for
 * candles/pricing and leaves MT5 EA as the exclusive execution transport.
 */

import { callScannerForCurrentUser } from '@/lib/scannerProxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  return callScannerForCurrentUser({
    internalPath: '/api/internal/oanda/ict',
    logTag: 'ICT_ANALYZE',
    payloadKey: 'ict',
    analysisOnly: true,
  });
}
