export const PAIR_PLAYBOOK_PRIORITY_POLICY_VERSION = 'playbook-window-priority-v1-2026-08-15';

const MIN_PAIR_WIN_RATE = 80;
const MIN_SAMPLE_SIZE = 50;
const MAX_PRIORITY_PAIRS = 3;

function numeric(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePair(value) {
  const pair = String(value || '').trim().replace('/', '_').toUpperCase();
  return /^[A-Z]{3}_[A-Z]{3}$/.test(pair) ? pair : null;
}

function normalizeWindow(value) {
  const window = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const timeBucketEt = String(window.timeBucketEt || window.time_bucket_15m || '').trim();
  if (!/^([01]\d|2[0-3]):(00|15|30|45)$/.test(timeBucketEt)) return null;
  return {
    timeBucketEt,
    session: String(window.session || '').trim() || null,
    direction: String(window.direction || '').trim().toLowerCase() || null,
    outcomes: numeric(window.outcomes, 0),
    winRate: numeric(window.winRate ?? window.win_rate),
    expectancyR: numeric(window.expectancyR ?? window.expectancy_r),
    profitFactor: numeric(window.profitFactor ?? window.profit_factor),
  };
}

export function nyQuarterHourBucket(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const read = (type) => parts.find((item) => item.type === type)?.value || '';
  const hour = Number(read('hour')) % 24;
  const minute = Number(read('minute'));
  return {
    weekday: read('weekday'),
    minuteOfDay: hour * 60 + minute,
    bucketEt: `${String(hour).padStart(2, '0')}:${String(Math.floor(minute / 15) * 15).padStart(2, '0')}`,
  };
}

function evaluatePlaybook(playbook, currentBucket, options) {
  const pair = normalizePair(playbook?.pair);
  const sampleSize = numeric(playbook?.sample_size ?? playbook?.sampleSize, 0);
  const winRate = numeric(playbook?.win_rate ?? playbook?.winRate);
  const expectancyR = numeric(playbook?.expectancy_r ?? playbook?.expectancyR);
  const profitFactor = numeric(playbook?.profit_factor ?? playbook?.profitFactor);
  const stage = String(playbook?.recommendation_stage ?? playbook?.stage ?? '').toLowerCase();
  const windows = (Array.isArray(playbook?.preferred_scalp_windows)
    ? playbook.preferred_scalp_windows
    : Array.isArray(playbook?.preferredWindows)
      ? playbook.preferredWindows
      : [])
    .map(normalizeWindow)
    .filter(Boolean);
  const matchedWindows = windows.filter((window) => window.timeBucketEt === currentBucket);

  const reasons = [];
  if (!pair) reasons.push('invalid_pair');
  if (playbook?.is_current === false) reasons.push('not_current');
  if (stage !== 'calibration_ready') reasons.push('not_calibration_ready');
  if (!(sampleSize >= options.minSampleSize)) reasons.push('insufficient_sample');
  if (!(winRate > options.minPairWinRate)) reasons.push('pair_win_rate_not_above_80');
  if (!(expectancyR > 0)) reasons.push('non_positive_expectancy');
  if (!(profitFactor > 1)) reasons.push('profit_factor_not_above_1');
  if (!windows.length) reasons.push('no_proven_windows');

  const eligible = reasons.length === 0;
  const windowMatched = eligible && matchedWindows.length > 0;
  return {
    playbookId: playbook?.id ? String(playbook.id) : null,
    version: numeric(playbook?.version, 0),
    pair,
    stage,
    sampleSize,
    winRate,
    expectancyR,
    profitFactor,
    eligible,
    windowMatched,
    matchedWindows,
    preferredWindows: windows,
    decision: !eligible ? 'ineligible' : windowMatched ? 'priority_selected_candidate' : 'outside_proven_window',
    reasons,
  };
}

/**
 * Selects account/engine playbooks for an earlier targeted scan. This policy
 * never changes confidence, R:R, risk, spread, news, margin, drawdown,
 * duplicate, or broker gates; the native engine still has to qualify a trade.
 */
export function buildPairPlaybookPriority(playbooks = [], now = new Date(), overrides = {}) {
  const options = {
    minPairWinRate: numeric(overrides.minPairWinRate, MIN_PAIR_WIN_RATE),
    minSampleSize: numeric(overrides.minSampleSize, MIN_SAMPLE_SIZE),
    maxPriorityPairs: Math.max(1, numeric(overrides.maxPriorityPairs, MAX_PRIORITY_PAIRS)),
  };
  const time = nyQuarterHourBucket(now);
  const evaluations = (Array.isArray(playbooks) ? playbooks : [])
    .map((playbook) => evaluatePlaybook(playbook, time.bucketEt, options));
  const selectedDetails = evaluations
    .filter((item) => item.windowMatched)
    .sort((a, b) =>
      numeric(b.winRate, 0) - numeric(a.winRate, 0) ||
      numeric(b.expectancyR, 0) - numeric(a.expectancyR, 0) ||
      numeric(b.sampleSize, 0) - numeric(a.sampleSize, 0) ||
      String(a.pair).localeCompare(String(b.pair)))
    .slice(0, options.maxPriorityPairs);

  const eligibleCount = evaluations.filter((item) => item.eligible).length;
  const selectedPairs = selectedDetails.map((item) => item.pair);
  return {
    version: PAIR_PLAYBOOK_PRIORITY_POLICY_VERSION,
    enabled: selectedPairs.length > 0,
    mode: 'matching_et_window_priority_prescan_only',
    accountScoped: true,
    nyTimeBucket: time.bucketEt,
    minPairWinRateExclusive: options.minPairWinRate,
    minSampleSize: options.minSampleSize,
    eligibleCount,
    windowMatchedCount: evaluations.filter((item) => item.windowMatched).length,
    selectedPairs,
    selectedDetails,
    evaluations,
    safeguards: {
      confidenceFloorChanged: false,
      rrGateChanged: false,
      riskBypass: false,
      spreadBypass: false,
      newsBypass: false,
      marginBypass: false,
      duplicateBypass: false,
    },
    reason: selectedPairs.length
      ? `Prioritizing ${selectedPairs.length} playbook pair(s) in the ${time.bucketEt} ET evidence window before the full scan.`
      : eligibleCount
        ? `${eligibleCount} playbook pair(s) exceed 80% win rate, but none match the current ${time.bucketEt} ET window.`
        : 'No current calibration-ready playbook exceeds the bounded priority requirements.',
  };
}
