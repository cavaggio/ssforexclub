/**
 * web/app/api/scanner/scan/route.ts
 *
 * Authenticated, per-user scanner endpoint. Calls the Railway scanner's
 * internal `/api/internal/oanda/scan` with credentials resolved from the
 * current user's broker connection. Hard-fails (409) when no usable
 * credentials exist — never falls back to platform defaults.
 *
 * The Railway legacy scanner still provides the dashboard's rich waterfall
 * context. Before returning it to the browser, this route normalizes the
 * directional calculation to the same native V3 policy used by Auto AI:
 * Daily/H4/M15, exact 2-of-3 = 67/pass. The old macro/structure/execution layer
 * confidence floors remain visible as diagnostics but are not shown as V3
 * execution blockers.
 */

import { NextResponse } from 'next/server';
import { callScannerForCurrentUser } from '@/lib/scannerProxy';
import {
  normalizeScanForV3Display,
  V3_PROVISIONING_POLICY_VERSION,
} from '@/lib/v3ScanDisplayPolicy.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type ScanRequestBody = { pairs?: string[] };

async function handle(req: Request) {
  let body: ScanRequestBody = {};
  try {
    body = (await req.json()) as ScanRequestBody;
  } catch {
    /* empty body is fine */
  }

  const response = await callScannerForCurrentUser({
    internalPath: '/api/internal/oanda/scan',
    logTag: 'SCANNER_SCAN',
    payloadKey: 'scan',
    extraBody: { pairs: Array.isArray(body.pairs) ? body.pairs : undefined },
  });

  if (!response.ok) return response;

  try {
    const envelope = (await response.json()) as Record<string, unknown>;
    const rawScan = envelope.scan && typeof envelope.scan === 'object'
      ? envelope.scan as Record<string, unknown>
      : {};

    const scan = normalizeScanForV3Display(rawScan);

    console.log(
      `[SCANNER_SCAN_POLICY] version=${V3_PROVISIONING_POLICY_VERSION} ` +
      `alignment=Daily/H4/M15-2of3 legacyConfidenceGates=diagnostic_only`,
    );

    return NextResponse.json({
      ...envelope,
      scan,
      policyVersion: V3_PROVISIONING_POLICY_VERSION,
    });
  } catch (err) {
    console.warn(
      `[SCANNER_SCAN_POLICY] normalization failed; returning original response: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
    return response;
  }
}

export async function POST(req: Request) {
  return handle(req);
}
