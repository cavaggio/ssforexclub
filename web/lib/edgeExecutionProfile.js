export const EDGE_EXECUTION_PROFILE_VERSION = 'edge-priority-v1-2026-07-14';

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function extractBrokerAccountId(row = {}) {
  const payload = object(row.payload);
  const raw = object(row.raw_payload);
  const nestedPayload = object(raw.payload);
  const request = object(raw.request);
  const executed = object(raw.executed);
  const result = object(raw.result);

  const candidates = [
    row.broker_account_id,
    payload.broker_account_id,
    payload.brokerAccountId,
    raw.broker_account_id,
    raw.brokerAccountId,
    nestedPayload.broker_account_id,
    nestedPayload.brokerAccountId,
    request.accountId,
    executed.brokerAccountId,
    result.brokerAccountId,
  ];

  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (value) return value;
  }

  return null;
}

/**
 * Learning must never intermingle broker accounts. Rows without a recoverable
 * broker account ID are excluded rather than guessed into the current account.
 */
export function filterRowsForBrokerAccount(rows = [], brokerAccountId) {
  const expected = String(brokerAccountId || '').trim();
  if (!expected) return [];

  return rows.filter((row) => extractBrokerAccountId(row) === expected);
}

function positivePair(group, minTrades) {
  return (
    Number(group?.trades || 0) >= minTrades &&
    numeric(group?.winRate) !== null &&
    numeric(group?.winRate) >= 55 &&
    numeric(group?.avgPnl) !== null &&
    numeric(group?.avgPnl) > 0
  );
}

function negativePair(group, minTrades) {
  return (
    Number(group?.trades || 0) >= minTrades &&
    numeric(group?.winRate) !== null &&
    numeric(group?.winRate) <= 35 &&
    numeric(group?.avgPnl) !== null &&
    numeric(group?.avgPnl) < 0
  );
}

/**
 * Convert per-account Edge Intelligence into a bounded execution aid.
 *
 * This does not lower or bypass V3 score, TP confidence, R:R, alignment, news,
 * spread, sizing, drawdown, margin, duplicate, or broker gates. It only gives
 * proven pairs an earlier pre-scan during full cycles.
 */
export function buildEdgeExecutionProfile(report = {}, options = {}) {
  const minOverallOutcomes = Number(options.minOverallOutcomes ?? 10);
  const minPairOutcomes = Number(options.minPairOutcomes ?? 3);
  const maxPreferredPairs = Number(options.maxPreferredPairs ?? 3);
  const outcomes = Number(report?.overall?.outcomes || 0);
  const bestPairs = Array.isArray(report?.edge?.bestPairs) ? report.edge.bestPairs : [];
  const worstPairs = Array.isArray(report?.edge?.worstPairs) ? report.edge.worstPairs : [];

  const preferredPairDetails = bestPairs
    .filter((group) => positivePair(group, minPairOutcomes))
    .slice(0, maxPreferredPairs)
    .map((group) => ({
      pair: String(group.key),
      trades: Number(group.trades || 0),
      winRate: numeric(group.winRate),
      avgPnl: numeric(group.avgPnl),
    }));

  const avoidPairDetails = worstPairs
    .filter((group) => negativePair(group, Math.max(5, minPairOutcomes)))
    .map((group) => ({
      pair: String(group.key),
      trades: Number(group.trades || 0),
      winRate: numeric(group.winRate),
      avgPnl: numeric(group.avgPnl),
    }));

  const sampleSufficient = outcomes >= minOverallOutcomes;
  const enabled = sampleSufficient && preferredPairDetails.length > 0;

  return {
    version: EDGE_EXECUTION_PROFILE_VERSION,
    enabled,
    mode: 'priority_prescan_only',
    accountScoped: true,
    outcomes,
    minimumOverallOutcomes: minOverallOutcomes,
    minimumPairOutcomes: minPairOutcomes,
    preferredPairs: preferredPairDetails.map((item) => item.pair),
    preferredPairDetails,
    avoidPairs: avoidPairDetails.map((item) => item.pair),
    avoidPairDetails,
    safeguards: {
      thresholdsChanged: false,
      alignmentBypass: false,
      riskBypass: false,
      brokerAccountGuessing: false,
    },
    reason: enabled
      ? `Prioritizing ${preferredPairDetails.length} historically positive pair(s) before the full V3 scan.`
      : !sampleSufficient
        ? `Need ${minOverallOutcomes} scored outcomes for this broker account; currently ${outcomes}.`
        : 'No pair has enough positive per-account evidence for priority treatment.',
  };
}
