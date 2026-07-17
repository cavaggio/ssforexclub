/**
 * Authenticated dashboard scan endpoint.
 *
 * The persisted Clerk-scoped Scanner / Auto AI engine is authoritative. The
 * browser may scope pairs, but it cannot choose or override the engine.
 */

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { callScannerForCurrentUser } from '@/lib/scannerProxy';
import { getUserTradingSettings } from '@/lib/userTradingSettings';
import {
  normalizeScanEngine,
  normalizeSelectedScan,
  scanEndpointForEngine,
} from '@/lib/scannerEngine';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type ScanRequestBody = { pairs?: unknown };

function normalizePairs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const pairs = [...new Set(
    value
      .map((pair) => String(pair || '').trim().toUpperCase())
      .filter(Boolean),
  )];
  return pairs.length ? pairs : undefined;
}

async function handle(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated' }, { status: 401 });
  }

  let body: ScanRequestBody = {};
  try {
    body = (await req.json()) as ScanRequestBody;
  } catch {
    // Empty body is valid. Engine selection never comes from the browser.
  }

  let selectedEngine: 'ict' | 'v3' | 'ppr';
  try {
    const settings = await getUserTradingSettings(userId);
    selectedEngine = normalizeScanEngine(settings.autoAiEngine) as 'ict' | 'v3' | 'ppr';
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  const route = scanEndpointForEngine(selectedEngine);
  const response = await callScannerForCurrentUser({
    internalPath: route.internalPath,
    logTag: route.logTag,
    payloadKey: 'scan',
    extraBody: { pairs: normalizePairs(body.pairs) },
  });

  let envelope: Record<string, any> = {};
  try {
    envelope = (await response.json()) as Record<string, any>;
  } catch {
    envelope = { ok: false, error: `Scanner returned an unreadable response for ${selectedEngine.toUpperCase()}.` };
  }

  if (!response.ok || !envelope?.ok) {
    return NextResponse.json(
      {
        ...envelope,
        ok: false,
        selectedEngine,
        scan: {
          engine: selectedEngine,
          qualified: [],
          watchCandidates: [],
          rejected: [],
          meta: { scanner: `${selectedEngine}_independent` },
        },
      },
      { status: response.status || 502 },
    );
  }

  try {
    const scan = normalizeSelectedScan(selectedEngine, envelope.scan);
    console.log(
      `[DASHBOARD_SCAN] selectedEngine=${selectedEngine} endpoint=${route.internalPath} ` +
      `qualified=${scan.qualified?.length ?? 0} watch=${scan.watchCandidates?.length ?? 0} ` +
      `rejected=${scan.rejected?.length ?? 0}`,
    );

    return NextResponse.json({
      ...envelope,
      ok: true,
      selectedEngine,
      scanner: scan.scanner,
      architecture: scan.architecture,
      scan,
    });
  } catch (err) {
    console.error(
      `[DASHBOARD_SCAN] normalization failed selectedEngine=${selectedEngine}:`,
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json(
      {
        ok: false,
        selectedEngine,
        error: `${selectedEngine.toUpperCase()} scanner response could not be rendered safely. Please run the scan again.`,
        scan: {
          engine: selectedEngine,
          qualified: [],
          watchCandidates: [],
          rejected: [],
          meta: { scanner: `${selectedEngine}_independent` },
        },
      },
      { status: 502 },
    );
  }
}

export async function POST(req: Request) {
  return handle(req);
}
