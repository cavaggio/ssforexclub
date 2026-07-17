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
  return `${pairOf(item) || 'unknown'}:${String(item?.direction || 'neutral').toLowerCase()}`;
}

function hydrateNativeSignal(item = {}) {
  const stage1 = item?.qualityConfirmation?.stage1;
  const primaryTimeframeAlignment = item?.primaryTimeframeAlignment || stage1?.metrics?.alignment || null;
  const alignment = {
    ...(item?.alignment || {}),
    timeframeAlignmentScore:
      item?.alignment?.timeframeAlignmentScore ?? primaryTimeframeAlignment?.score ?? null,
    tradeQualified:
      item?.alignment?.tradeQualified ?? primaryTimeframeAlignment?.passed === true,
    primaryConflictPolicy: 'native_v3_only',
    primaryConflictingTimeframes:
      item?.alignment?.primaryConflictingTimeframes || primaryTimeframeAlignment?.opposingTimeframes || [],
  };

  return {
    ...item,
    v3Score: item?.v3Score ?? item?.v3?.score ?? item?.score ?? stage1?.metrics?.score ?? null,
    primaryTimeframeAlignment,
    alignment,
    architecture: 'independent_v3_raw_market_data',
    legacyScannerUsed: false,
    legacyConfirmationsUsed: false,
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
 * No legacy scanner signal, direction, confidence, promotion, or confirmation is
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
    legacyScannerUsed: false,
    legacyConfirmationsUsed: false,
    meta: {
      ...(nativeScan?.meta || {}),
      scannedAt,
      scanner: 'v3_independent',
      calculationSource: 'independent_v3_raw_market_data',
      policyVersion: V3_DASHBOARD_SCAN_POLICY_VERSION,
      stageOrder: ['stage1', 'stage2'],
      legacyScannerUsed: false,
      legacyConfirmationsUsed: false,
      nearQualifiedCount: buckets.nearQualified.length,
      hotWatchCount: buckets.hotWatch.length,
    },
  };
}
