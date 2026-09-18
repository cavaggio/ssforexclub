export const PAIR_PLAYBOOK_EXECUTION_GATE_VERSION = 'edge-negative-expectancy-hard-gate-v1-2026-09-18';

const DEFAULT_MIN_PLAYBOOK_SAMPLE = 100;
const DEFAULT_MIN_CONDITION_OUTCOMES = 50;
const DEFAULT_MAX_NEGATIVE_EXPECTANCY_R = -0.15;

function finite(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePair(value) {
  const pair = String(value || '').trim().replace('/', '_').toUpperCase();
  return /^[A-Z]{3}_[A-Z]{3}$/.test(pair) ? pair : null;
}

function normalizeDirection(value) {
  const direction = String(value || '').trim().toLowerCase();
  if (['long', 'buy', 'bullish'].includes(direction)) return 'long';
  if (['short', 'sell', 'bearish'].includes(direction)) return 'short';
  return null;
}

function normalizeBias(value) {
  const bias = String(value || '').trim().toLowerCase();
  if (['bullish', 'long', 'buy'].includes(bias)) return 'bullish';
  if (['bearish', 'short', 'sell'].includes(bias)) return 'bearish';
  return bias || null;
}

function normalizeLoose(value) {
  const text = String(value || '').trim().toLowerCase();
  return text || null;
}

function candidateContext(candidate = {}) {
  return {
    pair: normalizePair(candidate.pair || candidate.instrument || candidate.symbol),
    direction: normalizeDirection(candidate.direction || candidate.side || candidate.signal),
    dailyDirection: normalizeBias(
      candidate.timeframeBias?.d1 ||
      candidate.dailyDirection ||
      candidate.dailyStudyContext?.dailyDirection ||
      candidate.dailyStudyContext?.dayDirection ||
      candidate.concepts?.htf?.dailyBias,
    ),
    h4Direction: normalizeBias(
      candidate.timeframeBias?.h4 ||
      candidate.h4Direction ||
      candidate.concepts?.htf?.h4Bias,
    ),
    marketRegime: normalizeLoose(candidate.marketRegime?.regime || candidate.marketRegime),
    volatility: normalizeLoose(candidate.volatilityState || candidate.volatility),
  };
}

function conditionMatches(condition = {}, context = {}) {
  const direction = normalizeDirection(condition.direction);
  const dailyDirection = normalizeBias(condition.dailyDirection ?? condition.daily_direction);
  const h4Direction = normalizeBias(condition.h4Direction ?? condition.h4_direction);
  const marketRegime = normalizeLoose(condition.marketRegime ?? condition.market_regime);
  const volatility = normalizeLoose(condition.volatility);

  if (direction && direction !== context.direction) return false;
  if (dailyDirection && dailyDirection !== context.dailyDirection) return false;
  if (h4Direction && h4Direction !== context.h4Direction) return false;
  if (marketRegime && marketRegime !== context.marketRegime) return false;
  if (volatility && volatility !== context.volatility) return false;
  return Boolean(direction || dailyDirection || h4Direction || marketRegime || volatility);
}

/**
 * Converts a statistically mature Edge Intelligence avoid-condition into an
 * authoritative AUTO-execution gate. This is deliberately narrow:
 * - only current, active, calibration-ready playbooks;
 * - only account/engine playbooks already approved for auto-trade priority;
 * - only a matching context with a substantial sample and negative expectancy.
 *
 * Manual execution is not decided here. Callers choose whether to enforce this
 * gate for autonomous orders while still exposing the evidence to the UI.
 */
export function evaluatePairPlaybookExecutionGate(candidate = {}, playbook = null, overrides = {}) {
  const context = candidateContext(candidate);
  const minPlaybookSample = Math.max(1, finite(overrides.minPlaybookSample, DEFAULT_MIN_PLAYBOOK_SAMPLE));
  const minConditionOutcomes = Math.max(1, finite(overrides.minConditionOutcomes, DEFAULT_MIN_CONDITION_OUTCOMES));
  const maxNegativeExpectancyR = finite(
    overrides.maxNegativeExpectancyR,
    DEFAULT_MAX_NEGATIVE_EXPECTANCY_R,
  );

  const base = {
    version: PAIR_PLAYBOOK_EXECUTION_GATE_VERSION,
    passed: true,
    decision: 'allow',
    authoritative: false,
    context,
    playbookId: playbook?.id ? String(playbook.id) : null,
    playbookVersion: finite(playbook?.version, 0),
    matchedCondition: null,
    failureCodes: [],
    reason: 'No mature negative-expectancy Edge Intelligence condition matched this candidate.',
  };

  if (!playbook || typeof playbook !== 'object') {
    return { ...base, reason: 'No current pair playbook is available; deterministic ICT gates remain authoritative.' };
  }

  const pair = normalizePair(playbook.pair);
  const sampleSize = finite(playbook.sample_size ?? playbook.sampleSize, 0);
  const status = String(playbook.status || '').trim().toLowerCase();
  const stage = String(playbook.recommendation_stage ?? playbook.recommendationStage ?? '').trim().toLowerCase();
  const validator = playbook.validator && typeof playbook.validator === 'object' ? playbook.validator : {};
  const scopeMatches = Boolean(pair && context.pair && pair === context.pair);
  const mature = scopeMatches &&
    playbook.is_current !== false &&
    status === 'active' &&
    stage === 'calibration_ready' &&
    sampleSize >= minPlaybookSample &&
    validator.approvedForAutoTradePriority === true;

  if (!mature) {
    return {
      ...base,
      reason: 'Pair playbook is not mature/active enough to create an autonomous execution gate.',
      sampleSize,
      status,
      stage,
    };
  }

  const matches = (Array.isArray(playbook.avoid_conditions) ? playbook.avoid_conditions : [])
    .filter((condition) => conditionMatches(condition, context))
    .map((condition) => ({
      ...condition,
      outcomes: finite(condition?.outcomes, 0),
      expectancyR: finite(condition?.expectancyR ?? condition?.expectancy_r),
    }))
    .filter((condition) =>
      condition.outcomes >= minConditionOutcomes &&
      condition.expectancyR != null &&
      condition.expectancyR <= maxNegativeExpectancyR
    )
    .sort((a, b) => a.expectancyR - b.expectancyR || b.outcomes - a.outcomes);

  if (!matches.length) {
    return {
      ...base,
      authoritative: true,
      sampleSize,
      status,
      stage,
      reason: 'Mature pair playbook checked; no sufficiently negative matching avoid-condition was found.',
    };
  }

  const matchedCondition = matches[0];
  return {
    ...base,
    passed: false,
    decision: 'reject',
    authoritative: true,
    sampleSize,
    status,
    stage,
    matchedCondition,
    failureCodes: ['EDGE_NEGATIVE_EXPECTANCY_CONTEXT'],
    reason:
      `Edge Intelligence blocks autonomous ${context.pair || pair || 'pair'} ${context.direction || 'trade'}: ` +
      `${matchedCondition.outcomes} matching outcomes have expectancy ${matchedCondition.expectancyR.toFixed(3)}R ` +
      `(hard-gate threshold <= ${Number(maxNegativeExpectancyR).toFixed(2)}R).`,
  };
}
