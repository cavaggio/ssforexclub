/**
 * web/app/api/scanner/scan/route.ts
 *
 * Authenticated, per-user native V3 scanner endpoint. Calls Railway's internal
 * `/api/internal/oanda/v3-scan` with credentials resolved from the current
 * user's active OANDA connection. The response is rendered directly from the
 * independent V3 raw-market scanner: Stage 1 is evaluated first, followed by
 * Stage 2. No legacy scanner signal, direction, confidence, promotion, or
 * confirmation is accepted by this route.
 */

import { NextResponse } from 'next/server';
import { callScannerForCurrentUser } from '@/lib/scannerProxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const V3_DASHBOARD_SCAN_POLICY_VERSION = 'v3-independent-stage1-stage2-2026-07-17';

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
    dashboardWatchTier: signal.dashboardWatchTier && typeof signal.dashboardWatchTier === 'object'
      ? {
          ...signal.dashboardWatchTier,
          tier: safeText(signal.dashboardWatchTier.tier, 'none'),
          reason: safeText(signal.dashboardWatchTier.reason),
        }
      : null,
    watchTier: signal.watchTier && typeof signal.watchTier === 'object'
      ? {
          ...signal.watchTier,
          tier: safeText(signal.watchTier.tier, 'none'),
          reason: safeText(signal.watchTier.reason),
        }
      : null,
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
      timeframeAlignmentScore: finiteNumber(
        alignment.timeframeAlignmentScore ?? signal.primaryTimeframeAlignment?.score,
      ),
      alignmentStatus: safeText(
        alignment.alignmentStatus,
        signal.primaryTimeframeAlignment?.passed === true ? 'aligned' : 'conflicting',
      ),
      dominantBias: safeText(alignment.dominantBias, signal.direction || 'ranging'),
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
    architecture: 'independent_v3_raw_market_data',
    legacyScannerUsed: false,
    legacyConfirmationsUsed: false,
  };
}

function safeSignalArray(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? value.map(makeSignalRenderSafe) : [];
}

function makeScanRenderSafe(scan: AnyRecord): AnyRecord {
  const meta = scan.meta && typeof scan.meta === 'object' ? scan.meta : {};
  return {
    ...scan,
    engine: 'v3',
    architecture: 'independent_v3_raw_market_data',
    legacyScannerUsed: false,
    legacyConfirmationsUsed: false,
    qualified: safeSignalArray(scan.qualified),
    rejected: safeSignalArray(scan.rejected),
    nearQualified: safeSignalArray(scan.nearQualified),
    hotWatch: safeSignalArray(scan.hotWatch),
    v3PrimaryPassedContext: [],
    meta: {
      ...meta,
      scanner: 'v3_independent',
      calculationSource: 'independent_v3_raw_market_data',
      policyVersion: V3_DASHBOARD_SCAN_POLICY_VERSION,
      stageOrder: ['stage1', 'stage2'],
      legacyScannerUsed: false,
      legacyConfirmationsUsed: false,
    },
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
    internalPath: '/api/internal/oanda/v3-scan',
    logTag: 'V3_SCANNER_SCAN',
    payloadKey: 'scan',
    extraBody: { pairs: Array.isArray(body.pairs) ? body.pairs : undefined },
  });

  if (!response.ok) return response;

  try {
    const envelope = (await response.json()) as Record<string, unknown>;
    const rawScan = envelope.scan && typeof envelope.scan === 'object'
      ? envelope.scan as AnyRecord
      : {};
    const scan = makeScanRenderSafe(rawScan);

    console.log(
      `[V3_SCANNER_SCAN_POLICY] version=${V3_DASHBOARD_SCAN_POLICY_VERSION} ` +
      `scanner=v3_independent stageOrder=stage1_then_stage2 ` +
      `legacyScannerUsed=false legacyConfirmationsUsed=false renderSafety=enabled`,
    );

    return NextResponse.json({
      ...envelope,
      scan,
      policyVersion: V3_DASHBOARD_SCAN_POLICY_VERSION,
      scanner: 'v3_independent',
      architecture: 'independent_v3_raw_market_data',
      legacyScannerUsed: false,
      legacyConfirmationsUsed: false,
    });
  } catch (err) {
    console.warn(
      `[V3_SCANNER_SCAN_POLICY] render normalization failed; returning safe empty scan: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );

    return NextResponse.json({
      ok: false,
      error: 'Native V3 scanner response could not be rendered safely. Please run the scan again.',
      scan: {
        engine: 'v3',
        architecture: 'independent_v3_raw_market_data',
        legacyScannerUsed: false,
        legacyConfirmationsUsed: false,
        qualified: [],
        rejected: [],
        nearQualified: [],
        hotWatch: [],
        v3PrimaryPassedContext: [],
        meta: {
          scanner: 'v3_independent',
          calculationSource: 'independent_v3_raw_market_data',
          policyVersion: V3_DASHBOARD_SCAN_POLICY_VERSION,
          stageOrder: ['stage1', 'stage2'],
          legacyScannerUsed: false,
          legacyConfirmationsUsed: false,
        },
      },
      policyVersion: V3_DASHBOARD_SCAN_POLICY_VERSION,
      scanner: 'v3_independent',
      legacyScannerUsed: false,
      legacyConfirmationsUsed: false,
    }, { status: 502 });
  }
}

export async function POST(req: Request) {
  return handle(req);
}
