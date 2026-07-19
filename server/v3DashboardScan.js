import { scanV3IndependentMarket } from './v3IndependentScanner.js';

export const V3_DASHBOARD_SCAN_POLICY_VERSION = 'v3-independent-stage1-stage2-2026-07-17';

function pairOf(item = {}) {
  return item?.pair || item?.instrument || item?.symbol || null;
}

function timingStatus(item = {}) {
  return String(item?.entryTiming?.status || item?.v3?.entryTiming?.status || '').toLowerCase();
}

function firstReason(values = [], fallback = '') {
  return Array.isArray(values) && values.length > 0
    ? String(values[0])
    : fallback;
}

function watchIdentity(item = {}) {
  return `${pairOf(item) || 'unknown'}:${String(item?.direction || item?.v3?.direction || 'neutral').toLowerCase()}`;
}

function normalizeTrend(value, fallback = 'n/a') {
  const trend = String(value || '').trim().toLowerCase();
  if (trend === 'long' || trend === 'buy' || trend === 'bull') return 'bullish';
  if (trend === 'short' || trend === 'sell' || trend === 'bear') return 'bearish';
  if (trend === 'bullish' || trend === 'bearish' || trend === 'neutral' || trend === 'ranging') return trend;
  return fallback;
}

function directionBias(direction) {
  const value = String(direction || '').toLowerCase();
  if (value === 'long') return 'bullish';
  if (value === 'short') return 'bearish';
  return null;
}

/**
 * Adapt native V3 fields into the dashboard's existing visual shape without
 * inventing foreign-engine analysis. Daily/H4/M15 come from V3's raw-candle classifier;
 * unavailable unavailable timeframes are explicitly marked n/a instead of flat.
 */
function hydrateNativeSignal(item = {}) {
  const v3 = item?.v3 || {};
  const stage1 = item?.qualityConfirmation?.stage1;
  const stage2 = item?.qualityConfirmation?.stage2;
  const direction = item?.direction || v3?.direction || null;
  const primaryTimeframeAlignment =
    item?.primaryTimeframeAlignment ||
    stage1?.metrics?.alignment ||
    v3?.primaryTimeframeAlignment ||
    null;
  const nativeTimeframes = v3?.timeframes || primaryTimeframeAlignment?.biases || {};
  const dailyTrend = normalizeTrend(nativeTimeframes?.daily);
  const h4Trend = normalizeTrend(nativeTimeframes?.h4);
  const m15Trend = normalizeTrend(nativeTimeframes?.m15);
  const structureTrend = normalizeTrend(v3?.structure?.structureTrend);
  const expectedBias = normalizeTrend(
    primaryTimeframeAlignment?.expected || directionBias(direction),
    'ranging',
  );
  const alignmentScore = Number(
    item?.alignment?.timeframeAlignmentScore ??
    primaryTimeframeAlignment?.score ??
    stage1?.metrics?.alignment?.score,
  );
  const safeAlignmentScore = Number.isFinite(alignmentScore) ? alignmentScore : 0;
  const alignmentPassed = primaryTimeframeAlignment?.passed === true;
  const alignmentStatus = alignmentPassed
    ? safeAlignmentScore >= 100 ? 'strong' : 'mixed'
    : 'conflicting';
  const v3Score = Number(item?.v3Score ?? v3?.score ?? item?.score ?? stage1?.metrics?.score);
  const safeV3Score = Number.isFinite(v3Score) ? v3Score : 0;
  const tpHitConfidence = Number(
    item?.tpHitConfidence ??
    stage1?.metrics?.tpHitConfidence ??
    item?.confidence,
  );
  const safeTpHitConfidence = Number.isFinite(tpHitConfidence) ? tpHitConfidence : 0;
  const structureStrength = Number(v3?.structure?.structureStrength);
  const safeStructureStrength = Number.isFinite(structureStrength) ? structureStrength : 0;
  const volatilityRegime = String(v3?.volatility?.volatilityState || 'unknown');
  const entryTiming = item?.entryTiming || v3?.entryTiming || null;

  const alignment = {
    ...(item?.alignment || {}),
    timeframes: {
      daily: dailyTrend,
      h4: h4Trend,
      h1: structureTrend,
      m30: 'n/a',
      m15: m15Trend,
      m5: 'n/a',
    },
    timeframeAlignmentScore: safeAlignmentScore,
    alignmentStatus,
    dominantBias: expectedBias,
    tradeQualified: alignmentPassed,
    primaryConflictPolicy: 'native_v3_only',
    conflictingTimeframes:
      item?.alignment?.conflictingTimeframes ||
      primaryTimeframeAlignment?.failures ||
      primaryTimeframeAlignment?.opposingTimeframes ||
      [],
    primaryConflictingTimeframes:
      item?.alignment?.primaryConflictingTimeframes ||
      primaryTimeframeAlignment?.opposingTimeframes ||
      [],
    contextConflictingTimeframes: [],
    rejectionReasons: alignmentPassed ? [] : [primaryTimeframeAlignment?.reason].filter(Boolean),
    warnings: [],
  };

  const macro = {
    ...(item?.macro || {}),
    macroBias: expectedBias,
    dailyTrend,
    h4Trend,
    volatilityRegime,
    macroConfidence: safeAlignmentScore,
    trendStrength: safeAlignmentScore,
    source: 'native_v3_raw_candles',
  };

  const structure = {
    ...(item?.structure || {}),
    h1Trend: structureTrend,
    m30Trend: 'n/a',
    reversalRisk: v3?.structure?.chochDetected === true ? 'medium' : 'low',
    structuralConfidence: safeStructureStrength,
    continuationProbability: safeStructureStrength,
    structureAligned: structureTrend === expectedBias,
    pullbackDetected: entryTiming?.status === 'wait_for_retest',
    source: 'native_v3_market_structure',
  };

  const momentum = {
    ...(item?.momentum || {}),
    m15Trend,
    m5Trend: 'n/a',
    executionSignal: direction === 'long' || direction === 'short' ? direction : null,
    executionConfidence: safeTpHitConfidence,
    momentumStrength: safeV3Score,
    entryQuality: safeV3Score,
    timingScore: stage2?.allowed === true ? 100 : stage2?.state === 'watch' ? 67 : 0,
    candleConfirmation: stage2?.primaryTriggers?.[0] || 'none',
    source: 'native_v3_stage2',
  };

  return {
    ...item,
    direction,
    score: Number.isFinite(Number(item?.score)) ? Number(item.score) : safeV3Score,
    v3Score: safeV3Score,
    confidence: Number.isFinite(Number(item?.confidence)) ? Number(item.confidence) : safeTpHitConfidence,
    tpHitConfidence: safeTpHitConfidence,
    primaryTimeframeAlignment,
    alignment,
    macro,
    structure,
    momentum,
    fibonacci: item?.fibonacci || v3?.fib || null,
    entryTiming,
    architecture: 'independent_v3_raw_market_data',
  };
}

function withWatchTier(item, tier, reason) {
  return {
    ...hydrateNativeSignal(item),
    dashboardWatchTier: { tier, reason },
    watchTier: { tier, reason },
    displayQualification: `v3_native_${tier}_watch`,
  };
}

function isTerminalTiming(item = {}) {
  const status = timingStatus(item);
  return status === 'late_entry' || status === 'invalidated';
}

function isStage1Developing(item = {}) {
  const stage1 = item?.qualityConfirmation?.stage1;
  if (!stage1 || stage1.allowed === true) return false;
  if (isTerminalTiming(item)) return false;
  if (item?.newsRisk?.blocked === true || stage1?.metrics?.newsBlocked === true) return false;

  const reasons = Array.isArray(stage1.reasons) ? stage1.reasons : [];
  const hardReason = reasons.some((reason) => {
    const value = String(reason || '').toLowerCase();
    return value.includes('missing pair') ||
      value.includes('missing v3 direction') ||
      value.includes('alignment failed') ||
      value.includes('alignment unavailable') ||
      value.includes('news block') ||
      value.includes('spread ') ||
      value.includes('remaining opportunity rejected') ||
      value.includes('geometric r:r');
  });

  return !hardReason;
}

/**
 * Convert only native independent-V3 results into the dashboard watch buckets.
 * No foreign-engine signal, direction, confidence, promotion, or confirmation is
 * accepted here.
 *
 * - Near Qualified: native Stage 1 was evaluated and is still developing.
 * - Hot Watch: native Stage 1 passed and native Stage 2 is waiting on a fresh
 *   market trigger/retest.
 * - Hard Stage 1/2 blockers remain in rejected and are not presented as waiting.
 */
export function classifyV3DashboardWatch(scan = {}) {
  const hotWatch = [];
  const nearQualified = [];
  const watched = new Set();

  for (const rawItem of Array.isArray(scan?.watchCandidates) ? scan.watchCandidates : []) {
    const item = hydrateNativeSignal(rawItem);
    const stage1 = item?.qualityConfirmation?.stage1;
    const stage2 = item?.qualityConfirmation?.stage2;
    const state = String(stage2?.state || '').toLowerCase();
    const timing = timingStatus(item);

    if (stage1?.allowed !== true || !stage2 || stage2.allowed === true) continue;
    if (isTerminalTiming(item)) continue;

    if (state === 'watch' || timing === 'too_early' || timing === 'wait_for_retest') {
      const reason = firstReason(
        stage2.reasons,
        item?.entryTiming?.reason || 'Stage 1 passed; native V3 Stage 2 is waiting for a fresh trigger or retest.',
      );
      const candidate = withWatchTier(item, 'hot', reason);
      hotWatch.push(candidate);
      watched.add(watchIdentity(candidate));
    }
  }

  for (const rawItem of Array.isArray(scan?.rejected) ? scan.rejected : []) {
    const item = hydrateNativeSignal(rawItem);
    const identity = watchIdentity(item);
    if (watched.has(identity) || !isStage1Developing(item)) continue;

    const stage1 = item?.qualityConfirmation?.stage1;
    const reason = firstReason(
      stage1?.reasons,
      item?.reason || 'Native V3 Stage 1 is still developing.',
    );
    const candidate = withWatchTier(item, 'near', reason);
    nearQualified.push(candidate);
    watched.add(identity);
  }

  const rejected = (Array.isArray(scan?.rejected) ? scan.rejected : [])
    .map(hydrateNativeSignal)
    .filter((item) => !watched.has(watchIdentity(item)));

  return { hotWatch, nearQualified, rejected };
}

export async function runV3DashboardScan({
  client,
  pairs = null,
  now = new Date(),
  log = () => {},
} = {}) {
  if (!client) throw new Error('V3 dashboard scan requires a user-scoped OANDA client');

  const rawScan = await scanV3IndependentMarket({
    pairs,
    client,
    now,
    scanMode: 'dashboard',
    log,
  });
  const nativeScan = {
    ...rawScan,
    qualified: (Array.isArray(rawScan?.qualified) ? rawScan.qualified : []).map(hydrateNativeSignal),
    rejected: (Array.isArray(rawScan?.rejected) ? rawScan.rejected : []).map(hydrateNativeSignal),
    watchCandidates: (Array.isArray(rawScan?.watchCandidates) ? rawScan.watchCandidates : []).map(hydrateNativeSignal),
  };
  const buckets = classifyV3DashboardWatch(nativeScan);
  const scannedAt = new Date().toISOString();

  return {
    ...nativeScan,
    rejected: buckets.rejected,
    nearQualified: buckets.nearQualified,
    hotWatch: buckets.hotWatch,
    v3PrimaryPassedContext: [],
    meta: {
      ...(nativeScan?.meta || {}),
      scannedAt,
      scanner: 'v3_independent',
      calculationSource: 'independent_v3_raw_market_data',
      policyVersion: V3_DASHBOARD_SCAN_POLICY_VERSION,
      stageOrder: ['stage1', 'stage2'],
          nearQualifiedCount: buckets.nearQualified.length,
      hotWatchCount: buckets.hotWatch.length,
    },
  };
}
