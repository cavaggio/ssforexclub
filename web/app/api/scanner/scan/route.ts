/**
 * web/app/api/scanner/scan/route.ts
 *
 * Authenticated, per-user scanner endpoint. Calls the Railway scanner's
 * internal `/api/internal/oanda/scan` with credentials resolved from the
 * current user's broker connection. Hard-fails (409) when no usable
 * credentials exist — never falls back to platform defaults.
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
type AnyRecord = Record<string, any>;

const EMPTY_TIMEFRAMES = {
  daily: 'neutral',
  h4: 'neutral',
  h1: 'neutral',
  m30: 'neutral',
  m15: 'neutral',
  m5: 'neutral',
};

function finiteNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value == null) return fallback;
  try {
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  } catch {
    return fallback;
  }
}

/**
 * The legacy scanner can return partial shapes for an individual pair when one
 * of its upstream analyses fails. The dashboard renders rich nested fields and
 * historically assumed all arrays/objects existed. Normalize every card to a
 * render-safe shape so one malformed pair cannot crash the entire dashboard.
 */
function makeSignalRenderSafe(raw: unknown): AnyRecord {
  const signal: AnyRecord = raw && typeof raw === 'object' ? raw as AnyRecord : {};
  const macro: AnyRecord = signal.macro && typeof signal.macro === 'object' ? signal.macro : {};
  const structure: AnyRecord = signal.structure && typeof signal.structure === 'object' ? signal.structure : {};
  const momentum: AnyRecord = signal.momentum && typeof signal.momentum === 'object' ? signal.momentum : {};
  const alignment: AnyRecord = signal.alignment && typeof signal.alignment === 'object' ? signal.alignment : {};
  const timeframes: AnyRecord = alignment.timeframes && typeof alignment.timeframes === 'object'
    ? alignment.timeframes
    : {};

  return {
    ...signal,
    pair: safeText(signal.pair || signal.instrument, 'UNKNOWN'),
    direction: signal.direction === 'long' || signal.direction === 'short' ? signal.direction : 'neutral',
    reason: safeText(signal.reason),
    rejectionReasons: Array.isArray(signal.rejectionReasons)
      ? signal.rejectionReasons.map((reason: unknown) => safeText(reason)).filter(Boolean)
      : [],
    macro: {
      ...macro,
      macroBias: safeText(macro.macroBias, 'ranging'),
      dailyTrend: safeText(macro.dailyTrend, 'neutral'),
      h4Trend: safeText(macro.h4Trend, 'neutral'),
      volatilityRegime: safeText(macro.volatilityRegime, 'unknown'),
      macroConfidence: finiteNumber(macro.macroConfidence),
      trendStrength: finiteNumber(macro.trendStrength),
    },
    structure: {
      ...structure,
      h1Trend: safeText(structure.h1Trend, 'neutral'),
      m30Trend: safeText(structure.m30Trend, 'neutral'),
      reversalRisk: safeText(structure.reversalRisk, 'low'),
      structuralConfidence: finiteNumber(structure.structuralConfidence),
      continuationProbability: finiteNumber(structure.continuationProbability),
      structureAligned: structure.structureAligned === true,
      pullbackDetected: structure.pullbackDetected === true,
    },
    momentum: {
      ...momentum,
      m15Trend: safeText(momentum.m15Trend, 'neutral'),
      m5Trend: safeText(momentum.m5Trend, 'neutral'),
      executionSignal: momentum.executionSignal === 'long' || momentum.executionSignal === 'short'
        ? momentum.executionSignal
        : null,
      executionConfidence: finiteNumber(momentum.executionConfidence),
      momentumStrength: finiteNumber(momentum.momentumStrength),
      entryQuality: finiteNumber(momentum.entryQuality),
      timingScore: finiteNumber(momentum.timingScore),
      candleConfirmation: safeText(momentum.candleConfirmation, 'none'),
    },
    alignment: {
      ...alignment,
      timeframes: {
        ...EMPTY_TIMEFRAMES,
        ...timeframes,
      },
      timeframeAlignmentScore: finiteNumber(alignment.timeframeAlignmentScore),
      alignmentStatus: safeText(alignment.alignmentStatus, 'conflicting'),
      dominantBias: safeText(alignment.dominantBias, 'ranging'),
      conflictingTimeframes: Array.isArray(alignment.conflictingTimeframes)
        ? alignment.conflictingTimeframes.map((value: unknown) => safeText(value)).filter(Boolean)
        : [],
      primaryConflictingTimeframes: Array.isArray(alignment.primaryConflictingTimeframes)
        ? alignment.primaryConflictingTimeframes.map((value: unknown) => safeText(value)).filter(Boolean)
        : [],
      contextConflictingTimeframes: Array.isArray(alignment.contextConflictingTimeframes)
        ? alignment.contextConflictingTimeframes.map((value: unknown) => safeText(value)).filter(Boolean)
        : [],
      rejectionReasons: Array.isArray(alignment.rejectionReasons)
        ? alignment.rejectionReasons.map((reason: unknown) => safeText(reason)).filter(Boolean)
        : [],
      warnings: Array.isArray(alignment.warnings)
        ? alignment.warnings.map((warning: unknown) => safeText(warning)).filter(Boolean)
        : [],
    },
  };
}

function makeScanRenderSafe(scan: AnyRecord): AnyRecord {
  return {
    ...scan,
    qualified: Array.isArray(scan.qualified) ? scan.qualified.map(makeSignalRenderSafe) : [],
    rejected: Array.isArray(scan.rejected) ? scan.rejected.map(makeSignalRenderSafe) : [],
    v3PrimaryPassedContext: Array.isArray(scan.v3PrimaryPassedContext)
      ? scan.v3PrimaryPassedContext.map(makeSignalRenderSafe)
      : [],
    meta: scan.meta && typeof scan.meta === 'object' ? scan.meta : {},
  };
}

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
      ? envelope.scan as AnyRecord
      : {};

    const normalized = normalizeScanForV3Display(rawScan);
    const scan = makeScanRenderSafe(normalized);

    console.log(
      `[SCANNER_SCAN_POLICY] version=${V3_PROVISIONING_POLICY_VERSION} ` +
      `alignment=Daily/H4/M15-2of3 legacyConfidenceGates=diagnostic_only ` +
      `renderSafety=enabled`,
    );

    return NextResponse.json({
      ...envelope,
      scan,
      policyVersion: V3_PROVISIONING_POLICY_VERSION,
    });
  } catch (err) {
    console.warn(
      `[SCANNER_SCAN_POLICY] normalization failed; returning safe empty scan: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );

    return NextResponse.json({
      ok: false,
      error: 'Scanner response could not be rendered safely. Please run the scan again.',
      scan: { qualified: [], rejected: [], v3PrimaryPassedContext: [], meta: {} },
      policyVersion: V3_PROVISIONING_POLICY_VERSION,
    }, { status: 502 });
  }
}

export async function POST(req: Request) {
  return handle(req);
}
