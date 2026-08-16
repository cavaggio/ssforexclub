const DEFAULT_REJECTION_THRESHOLD = 1.75;
const MIN_SAMPLES_FOR_ADJUST = 10;
const LOOKBACK_TRADES = 60;

function numeric(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, places = 2) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function expectedRFromSnapshot(snapshot) {
  const queue = [object(snapshot)];
  const visited = new Set();
  let inspected = 0;
  while (queue.length && inspected < 500) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    inspected += 1;
    for (const key of ['expectedRR', 'actualFillRR', 'riskReward', 'riskRewardRatio', 'entryRiskRewardRatio', 'rr']) {
      const value = numeric(current[key]);
      if (value !== null && value > 0) return value;
    }
    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}

export function expectedRForLifecycle(row = {}) {
  const stored = expectedRFromSnapshot(row.opening_snapshot);
  if (stored !== null) return stored;
  const entry = numeric(row.entry_price);
  const stop = numeric(row.stop_loss);
  const target = numeric(row.take_profit);
  if (entry === null || stop === null || target === null) return null;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  return Math.abs(target - entry) / risk;
}

function normalizedLifecycle(row = {}) {
  const expectedR = expectedRForLifecycle(row);
  const realizedR = numeric(row.realized_r);
  const timestamp = String(row.closed_at || row.opened_at || '');
  const date = new Date(timestamp);
  if (expectedR === null || realizedR === null || Number.isNaN(date.getTime())) return null;
  return {
    expectedR,
    realizedR,
    timestamp: date.toISOString(),
    result: String(row.result || '').toLowerCase(),
    engine: String(row.engine || '').toLowerCase(),
  };
}

function thresholdForCapture(captureRatio) {
  if (captureRatio === null || !Number.isFinite(captureRatio) || captureRatio >= 0.95) return 1.75;
  if (captureRatio >= 0.85) return 1.85;
  if (captureRatio >= 0.75) return 2;
  if (captureRatio >= 0.65) return 2.15;
  if (captureRatio >= 0.55) return 2.3;
  return 2.5;
}

function monthlyBuckets(trades) {
  const buckets = new Map();
  for (const trade of trades) {
    const month = trade.timestamp.slice(0, 7);
    const bucket = buckets.get(month) || { month, sampleCount: 0, wins: 0, sumExpected: 0, sumRealized: 0 };
    bucket.sampleCount += 1;
    bucket.sumExpected += trade.expectedR;
    bucket.sumRealized += trade.realizedR;
    if (trade.result === 'win') bucket.wins += 1;
    buckets.set(month, bucket);
  }
  return [...buckets.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((bucket) => ({
      month: bucket.month,
      sampleCount: bucket.sampleCount,
      avgExpectedRR: round(bucket.sumExpected / bucket.sampleCount),
      avgRealizedR: round(bucket.sumRealized / bucket.sampleCount),
      winRate: round(bucket.wins / bucket.sampleCount),
      captureRatio: bucket.sumExpected > 0 ? round(bucket.sumRealized / bucket.sumExpected) : 0,
    }));
}

function maskAccount(accountId) {
  const value = String(accountId || '');
  return value.length > 6 ? `${value.slice(0, 3)}…${value.slice(-3)}` : '***';
}

/**
 * @param {{
 *   lifecycles?: any[],
 *   audits?: any[],
 *   priorityAudit?: any,
 *   brokerAccountId?: string,
 *   environment?: string,
 *   computedAt?: Date|string|number,
 * }} input
 */
export function buildAccountCalibrationSnapshot({
  lifecycles = [],
  audits = [],
  priorityAudit = null,
  brokerAccountId = '',
  environment = 'unknown',
  computedAt = new Date(),
} = {}) {
  const resolvedTradeCount = (Array.isArray(lifecycles) ? lifecycles : [])
    .filter((row) => String(row?.state || '').toLowerCase() === 'closed' && numeric(row?.realized_r) !== null)
    .length;
  const trades = (Array.isArray(lifecycles) ? lifecycles : [])
    .map(normalizedLifecycle)
    .filter(Boolean)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, LOOKBACK_TRADES);
  const sumExpected = trades.reduce((sum, trade) => sum + trade.expectedR, 0);
  const sumRealized = trades.reduce((sum, trade) => sum + trade.realizedR, 0);
  const captureRatio = trades.length && sumExpected > 0 ? round(sumRealized / sumExpected) : null;
  const eligible = trades.length >= MIN_SAMPLES_FOR_ADJUST;
  const diagnosticThreshold = eligible ? thresholdForCapture(captureRatio) : DEFAULT_REJECTION_THRESHOLD;

  const scopedAudits = Array.isArray(audits) ? audits : [];
  const adjustedAudits = scopedAudits.filter((audit) => numeric(audit?.combined_adjustment, 0) !== 0);
  const latestAudit = scopedAudits[0] || null;
  const linkedTradeCount = (Array.isArray(lifecycles) ? lifecycles : [])
    .filter((row) => row?.learning_audit_id)
    .length;

  return {
    monthly: monthlyBuckets(trades),
    rolling: {
      sampleCount: trades.length,
      resolvedTradeCount,
      sumExpected: round(sumExpected),
      sumRealized: round(sumRealized),
      avgExpectedRR: trades.length ? round(sumExpected / trades.length) : undefined,
      avgRealizedR: trades.length ? round(sumRealized / trades.length) : undefined,
      captureRatio,
    },
    defaultRejectionThreshold: DEFAULT_REJECTION_THRESHOLD,
    calibratedRejectionThreshold: diagnosticThreshold,
    eligibleForAdjustment: eligible,
    minSamplesForAdjust: MIN_SAMPLES_FOR_ADJUST,
    lookbackTrades: LOOKBACK_TRADES,
    adjustmentReason: eligible
      ? `Actual broker capture ratio ${captureRatio}; the diagnostic Expected-RR threshold is ${diagnosticThreshold}. Per-candidate confidence learning is verified separately below.`
      : `Insufficient actual broker history (${trades.length}/${MIN_SAMPLES_FOR_ADJUST} resolved trades with planned and realized R). Confidence learning still evaluates every candidate from the available account evidence.`,
    source: 'actual_trade_lifecycles',
    accountScoped: true,
    brokerAccountMask: maskAccount(brokerAccountId),
    environment,
    thresholdApplication: 'diagnostic_only',
    executionApplication: {
      source: 'engine_learning_adjustment_audit',
      evaluatedCandidates: scopedAudits.length,
      adjustedCandidates: adjustedAudits.length,
      linkedActualTrades: linkedTradeCount,
      lastEvaluatedAt: latestAudit?.observed_at || latestAudit?.created_at || null,
      lastEngine: latestAudit?.engine || null,
      lastPair: latestAudit?.pair || null,
      lastOriginalConfidence: numeric(latestAudit?.original_confidence),
      lastFinalConfidence: numeric(latestAudit?.final_confidence),
      confidenceFloor: 75,
      appliedAtCandidateLevel: scopedAudits.length > 0,
    },
    playbookPriority: priorityAudit ? {
      source: 'pair_playbook_priority_audit',
      lastEvaluatedAt: priorityAudit.created_at || null,
      engine: priorityAudit.engine || null,
      nyTimeBucket: priorityAudit.ny_time_bucket || null,
      playbooksLoaded: numeric(priorityAudit.playbooks_loaded, 0),
      eligiblePlaybooks: numeric(priorityAudit.eligible_playbooks, 0),
      windowMatchedPlaybooks: numeric(priorityAudit.window_matched_playbooks, 0),
      selectedPairs: Array.isArray(priorityAudit.selected_pairs) ? priorityAudit.selected_pairs : [],
      prescanAttempted: priorityAudit.prescan_attempted === true,
      prescanOk: priorityAudit.prescan_ok === true,
    } : null,
    computedAt: (computedAt instanceof Date ? computedAt : new Date(computedAt)).toISOString(),
  };
}
