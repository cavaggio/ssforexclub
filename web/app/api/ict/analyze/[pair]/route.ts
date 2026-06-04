/**
 * web/app/api/ict/analyze/[pair]/route.ts
 *
 * ICT Intelligence — analyse a single pair. Same authenticated proxy path as
 * the all-pairs route, scoped via `pairs:[pair]`. Read-only / shadow.
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
    extraBody: { pairs: [pair.toUpperCase()] },
  });
}
