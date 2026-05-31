/**
 * web/app/api/scanner/calibration/route.ts
 *
 * Authenticated calibration endpoint. Forwards to Railway's internal
 * /api/internal/oanda/calibration with the shared secret. No broker
 * credentials required — the underlying endpoint reads the trade-history
 * file. Returns the calibration snapshot used by the scanner to auto-adjust
 * the rejection threshold.
 */

import { callScannerForCurrentUser } from '@/lib/scannerProxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  return callScannerForCurrentUser({
    internalPath: '/api/internal/oanda/calibration',
    logTag: 'SCANNER_CALIBRATION',
    payloadKey: 'calibration',
    skipCredentials: true,
  });
}
