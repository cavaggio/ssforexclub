export const V3_PROVISIONING_POLICY_VERSION = 'v3-primary-2of3-2026-07-14';

const PRIMARY = ['daily', 'h4', 'm15'];
const CONTEXT = ['h1', 'm30', 'm5'];

function norm(value) {
  const text = String(value || '').trim().toLowerCase();
  if (['bull', 'bullish', 'buy', 'long', 'up'].includes(text)) return 'bullish';
  if (['bear', 'bearish', 'sell', 'short', 'down'].includes(text)) return 'bearish';
  if (['neutral', 'flat', 'range', 'ranging', 'mixed', 'none'].includes(text)) return 'neutral';
  return text || null;
}

function directionBias(value) {
  const text = String(value || '').trim().toLowerCase();
  if (['long', 'buy', 'bullish'].includes(text)) return 'bullish';
  if (['short', 'sell', 'bearish'].includes(text)) return 'bearish';
  return null;
}

function directionFromBias(value) {
  return value === 'bullish' ? 'long' : value === 'bearish' ? 'short' : null;
}

function readTimeframes(signal = {}) {
  const source = signal?.alignment?.timeframes || signal?.timeframes || {};
  return {
    daily: norm(source.daily ?? signal?.macro?.dailyTrend),
    h4: norm(source.h4 ?? signal?.macro?.h4Trend),
    h1: norm(source.h1 ?? signal?.structure?.h1Trend),
    m30: norm(source.m30 ?? signal?.structure?.m30Trend),
    m15: norm(source.m15 ?? signal?.momentum?.m15Trend),
    m5: norm(source.m5 ?? signal?.momentum?.m5Trend),
  };
}

function majorityBias(timeframes) {
  const values = PRIMARY.map((tf) => timeframes[tf]);
  const bullish = values.filter((value) => value === 'bullish').length;
  const bearish = values.filter((value) => value === 'bearish').length;
  if (bullish >= 2) return 'bullish';
  if (bearish >= 2) return 'bearish';
  return null;
}

export function calculateDashboardPrimaryAlignment(signal = {}) {
  const timeframes = readTimeframes(signal);
  const explicit =
    directionBias(signal?.direction) ||
    directionBias(signal?.v3?.direction) ||
    directionBias(signal?.momentum?.executionSignal);
  const expected = explicit || majorityBias(timeframes);
  const missingTimeframes = PRIMARY.filter((tf) => !timeframes[tf]);

  if (!expected || missingTimeframes.length) {
    return {
      passed: false,
      score: 0,
      expected,
      direction: directionFromBias(expected),
      policyVersion: V3_PROVISIONING_POLICY_VERSION,
      minimumScore: 67,
      timeframes,
      alignedTimeframes: [],
      opposingTimeframes: [],
      neutralTimeframes: [],
      contextConflicts: [],
      missingTimeframes,
      reason: missingTimeframes.length
        ? `Primary timeframe data missing: ${missingTimeframes.join(', ')}.`
        : 'No two-of-three Daily/H4/M15 direction is available.',
    };
  }

  const opposite = expected === 'bullish' ? 'bearish' : 'bullish';
  const alignedTimeframes = PRIMARY.filter((tf) => timeframes[tf] === expected);
  const opposingTimeframes = PRIMARY.filter((tf) => timeframes[tf] === opposite);
  const neutralTimeframes = PRIMARY.filter((tf) => timeframes[tf] === 'neutral');
  const contextConflicts = CONTEXT.filter((tf) => {
    const value = timeframes[tf];
    return value && value !== 'neutral' && value !== expected;
  });
  const score = [0, 33, 67, 100][alignedTimeframes.length] ?? 0;
  const passed = score >= 67;

  return {
    passed,
    score,
    expected,
    direction: directionFromBias(expected),
    policyVersion: V3_PROVISIONING_POLICY_VERSION,
    minimumScore: 67,
    timeframes,
    alignedTimeframes,
    opposingTimeframes,
    neutralTimeframes,
    contextConflicts,
    missingTimeframes,
    reason: passed
      ? `Daily/H4/M15 alignment passed at ${score}/100 (${alignedTimeframes.length}/3). ` +
        `${opposingTimeframes.length ? `${opposingTimeframes.join(', ')} opposing is diagnostic only.` : ''}`.trim()
      : `Daily/H4/M15 alignment failed at ${score}/100; minimum is 67/100.`,
  };
}

function isObsoleteLegacyConfidenceReason(reason) {
  const text = String(reason || '');
  return (
    /^Macro confidence \d+(?:\.\d+)? < min \d+/i.test(text) ||
    /^Structural confidence \d+(?:\.\d+)? < min \d+/i.test(text) ||
    /^Execution confidence \d+(?:\.\d+)? < min \d+/i.test(text)
  );
}

function isObsoleteDirectionalReason(reason) {
  const text = String(reason || '').toLowerCase();
  return (
    text.includes('macro bias is ranging') ||
    text.includes('momentum layer produced no execution signal') ||
    text.includes('execution direction') && text.includes('opposes macro bias') ||
    text.includes('primary timeframe alignment failed') ||
    text.includes('primary timeframe conflict')
  );
}

/**
 * The dashboard scanner still receives rich legacy-waterfall context. Normalize
 * only the displayed directional policy so it matches the native V3 Auto AI
 * engine. This function never places trades or bypasses news, spread, R:R,
 * reversal-risk, Stage 1, Stage 2, sizing, margin, or broker checks.
 */
export function normalizeSignalForV3Display(signal = {}) {
  const primary = calculateDashboardPrimaryAlignment(signal);
  const originalReasons = Array.isArray(signal.rejectionReasons)
    ? signal.rejectionReasons
    : Array.isArray(signal?.alignment?.rejectionReasons)
      ? signal.alignment.rejectionReasons
      : signal.reason
        ? [signal.reason]
        : [];

  const removedDiagnostics = [];
  const retainedReasons = [];

  for (const reason of originalReasons) {
    if (isObsoleteLegacyConfidenceReason(reason)) {
      removedDiagnostics.push(String(reason));
      continue;
    }
    if (primary.passed && isObsoleteDirectionalReason(reason)) {
      removedDiagnostics.push(String(reason));
      continue;
    }
    retainedReasons.push(String(reason));
  }

  const warnings = [
    ...(Array.isArray(signal?.alignment?.warnings) ? signal.alignment.warnings : []),
    ...removedDiagnostics.map((reason) => `Legacy diagnostic only: ${reason}`),
  ];

  const direction = signal.direction || primary.direction || signal?.v3?.direction || null;
  const displayQualification = primary.passed && retainedReasons.length === 0
    ? 'primary_alignment_passed_legacy_diagnostics_only'
    : 'additional_valid_gate_failed';

  const alignment = {
    ...(signal.alignment || {}),
    timeframeAlignmentScore: primary.score,
    alignmentStatus: primary.score === 100 ? 'strong' : primary.passed ? 'mixed' : 'conflicting',
    dominantBias: primary.expected || signal?.alignment?.dominantBias || 'ranging',
    conflictingTimeframes: primary.opposingTimeframes,
    primaryConflictingTimeframes: primary.opposingTimeframes,
    contextConflictingTimeframes: primary.contextConflicts,
    tradeQualified: displayQualification === 'primary_alignment_passed_legacy_diagnostics_only',
    rejectionReasons: retainedReasons,
    warnings,
    primaryPolicy: primary,
    policyVersion: V3_PROVISIONING_POLICY_VERSION,
    legacyConfidenceDiagnostics: {
      macroConfidence: Number(signal?.macro?.macroConfidence ?? 0),
      structuralConfidence: Number(signal?.structure?.structuralConfidence ?? 0),
      executionConfidence: Number(signal?.momentum?.executionConfidence ?? 0),
      gateStatus: 'diagnostic_only_for_v3',
    },
  };

  return {
    ...signal,
    direction,
    alignment,
    primaryTimeframeAlignment: primary,
    rejectionReasons: retainedReasons,
    reason: retainedReasons[0] || primary.reason,
    policyVersion: V3_PROVISIONING_POLICY_VERSION,
    legacyDiagnosticsRemoved: removedDiagnostics,
    displayQualification,
  };
}

export function normalizeScanForV3Display(scan = {}) {
  const qualified = Array.isArray(scan.qualified)
    ? scan.qualified.map(normalizeSignalForV3Display)
    : [];
  const normalizedRejected = Array.isArray(scan.rejected)
    ? scan.rejected.map(normalizeSignalForV3Display)
    : [];

  // Never promote a legacy dashboard result into the executable qualified list.
  // A pair that only failed obsolete legacy confidence/directional checks is
  // removed from the red Rejected section and returned separately for audit.
  // Native V3 Auto AI remains the only authority that can qualify it to trade.
  const v3PrimaryPassedContext = normalizedRejected.filter(
    (signal) =>
      signal.displayQualification ===
      'primary_alignment_passed_legacy_diagnostics_only',
  );
  const rejected = normalizedRejected.filter(
    (signal) =>
      signal.displayQualification !==
      'primary_alignment_passed_legacy_diagnostics_only',
  );

  return {
    ...scan,
    qualified,
    rejected,
    v3PrimaryPassedContext,
    meta: {
      ...(scan.meta || {}),
      policyVersion: V3_PROVISIONING_POLICY_VERSION,
      primaryAlignmentMinimum: 67,
      primaryAlignmentRule: 'Daily/H4/M15 exact two-of-three',
      legacyLayerConfidencePolicy: 'diagnostic_only_for_v3',
      executionEngine: 'v3_native_auto_ai',
      dashboardAnalysisEngine: 'legacy_context_normalized_to_v3_policy',
      v3PrimaryPassedContextCount: v3PrimaryPassedContext.length,
    },
  };
}
