/**
 * ICT Intelligence — analyse a single pair. Read-only market analysis remains
 * available when FTMO is the active execution broker.
 */

import { callScannerForCurrentUser } from '@/lib/scannerProxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(_req: Request, ctx: { params: Promise<{ pair: string }> }) {
  const { pair } = await ctx.params;
  return callScannerForCurrentUser({
    internalPath: '/api/internal/oanda/ict',
    logTag: 'ICT_ANALYZE_PAIR',
    payloadKey: 'ict',
    analysisOnly: true,
    extraBody: { pairs: [pair.toUpperCase()] },
  });
}
