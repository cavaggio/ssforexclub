const HORIZONS = Object.freeze([15, 30, 60, 120]);

const SOURCE_BUCKETS = Object.freeze([
  ['executed', 'executed'],
  ['qualifiedCandidates', 'qualified'],
  ['qualifiedSignals', 'qualified'],
  ['candidates', 'candidate'],
  ['signals', 'candidate'],
  ['results', 'candidate'],
  ['watchCandidates', 'watching'],
  ['nearQualifiedCandidates', 'near_qualified'],
  ['nearQualified', 'near_qualified'],
  ['hotCandidates', 'hot_watch'],
  ['lateEntryCandidates', 'late_entry'],
  ['rejectedCandidates', 'rejected'],
  ['rejected', 'rejected'],
]);

const DIRECT_CONFIRMATIONS = Object.freeze([
  'liquiditySweep', 'sweepConfirmed', 'liquidityRaid', 'displacement',
  'bos', 'choch', 'mss', 'marketStructureShift', 'fvg', 'fairValueGap',
  'orderBlock', 'breaker', 'breakerBlock', 'ote', 'smt', 'smtDivergence',
  'premiumDiscount', 'sessionAlignment', 'higherTimeframeAlignment',
  'volumeConfirmation', 'momentumConfirmation', 'rejectionWick',
  'newsSafe', 'trendAlignment', 'entryTimingValid', 'liquidityTargetValid',
]);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function first(objects, keys) {
  for (const source of objects) {
    const current = object(source);
    for (const key of keys) {
      if (current[key] !== undefined && current[key] !== null && current[key] !== '') return current[key];
    }
  }
  return null;
}

function boolish(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  if (typeof value === 'number') return value > 0;
  return ['true', 'yes', 'confirmed', 'present', 'pass', 'passed', 'valid'].includes(String(value).toLowerCase());
}

export function normalizePair(value) {
  const normalized = String(value || '').trim().replace('/', '_').toUpperCase();
  return /^[A-Z]{3}_[A-Z]{3}$/.test(normalized) ? normalized : null;
}

function normalizeDirection(value) {
  const direction = String(value || '').toLowerCase();
  if (['long', 'buy', 'bullish'].includes(direction)) return 'long';
  if (['short', 'sell', 'bearish'].includes(direction)) return 'short';
  return null;
}

function normalizeKey(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => normalizeKey(value)).filter(Boolean))];
}

function nyParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const read = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  const year = read('year');
  const month = read('month');
  const day = read('day');
  const hour = read('hour') % 24;
  const minute = read('minute');
  return {
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    minuteOfDay: hour * 60 + minute,
    bucket15m: `${String(hour).padStart(2, '0')}:${String(Math.floor(minute / 15) * 15).padStart(2, '0')}`,
  };
}

function inferSession(minuteOfDay) {
  if (minuteOfDay >= 420 && minuteOfDay < 600) return 'london_new_york_overlap';
  if (minuteOfDay >= 120 && minuteOfDay < 420) return 'london';
  if (minuteOfDay >= 600 && minuteOfDay < 720) return 'new_york';
  if (minuteOfDay >= 1140 || minuteOfDay < 120) return 'asian';
  return 'off_session';
}

function mergedCandidate(value) {
  const item = object(value);
  const signal = object(item.signal);
  const candidate = object(item.candidate);
  return { ...signal, ...candidate, ...item };
}

export function collectScanCandidates(payload = {}) {
  const root = object(payload);
  const collected = [];
  for (const [key, defaultStatus] of SOURCE_BUCKETS) {
    const values = Array.isArray(root[key]) ? root[key] : [];
    values.forEach((raw, index) => {
      const item = mergedCandidate(raw);
      if (!normalizePair(first([item, item.analysis], ['pair', 'instrument', 'symbol']))) return;
      collected.push({ item, sourceBucket: key, defaultStatus, sourceIndex: index });
    });
  }

  const single = mergedCandidate(root.signal || root.candidate);
  if (normalizePair(first([single, single.analysis], ['pair', 'instrument', 'symbol']))) {
    collected.push({ item: single, sourceBucket: 'signal', defaultStatus: 'candidate', sourceIndex: 0 });
  }

  const seen = new Set();
  return collected.filter((record) => {
    const pair = normalizePair(first([record.item, record.item.analysis], ['pair', 'instrument', 'symbol']));
    const direction = normalizeDirection(first([record.item, record.item.analysis], ['direction', 'side', 'signal']));
    const entry = numeric(first([record.item, record.item.analysis], ['entry', 'entryPrice', 'fillPrice', 'currentPrice', 'price']));
    const key = `${record.sourceBucket}:${record.sourceIndex}:${pair}:${direction}:${entry}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function confirmationMap(item) {
  const analysis = object(item.analysis);
  const riskModel = object(analysis.riskModel);
  const timing = object(analysis.timing);
  const supplied = { ...object(analysis.confirmations), ...object(item.confirmations) };
  const confirmations = {};

  for (const [key, value] of Object.entries(supplied)) {
    if (boolish(value)) confirmations[normalizeKey(key)] = true;
  }

  const concepts = [
    ...(Array.isArray(item.conceptsDetected) ? item.conceptsDetected : []),
    ...(Array.isArray(analysis.conceptsDetected) ? analysis.conceptsDetected : []),
  ];
  for (const concept of concepts) confirmations[normalizeKey(concept)] = true;

  const sources = [item, analysis, riskModel, timing];
  for (const key of DIRECT_CONFIRMATIONS) {
    if (boolish(first(sources, [key]))) confirmations[normalizeKey(key)] = true;
  }

  return confirmations;
}

function missingConfirmations(item) {
  const analysis = object(item.analysis);
  const values = [
    ...(Array.isArray(item.missingConfirmations) ? item.missingConfirmations : []),
    ...(Array.isArray(item.failedConfirmations) ? item.failedConfirmations : []),
    ...(Array.isArray(analysis.missingConfirmations) ? analysis.missingConfirmations : []),
    ...(Array.isArray(analysis.failedConfirmations) ? analysis.failedConfirmations : []),
  ];
  return uniqueStrings(values);
}

function explicitStatus(item, fallback) {
  if (item.executed === true || item.tradeId || item.orderId || item.fillPrice) return 'executed';
  if (item.qualified === true) return 'qualified';
  if (item.rejected === true || item.allowed === false) return 'rejected';
  const raw = String(item.status || item.state || fallback || 'candidate').toLowerCase();
  const allowed = new Set([
    'candidate', 'watching', 'near_qualified', 'hot_watch', 'late_entry',
    'qualified', 'executed', 'rejected', 'market_study',
  ]);
  return allowed.has(raw) ? raw : fallback;
}

function priceFields(item) {
  const analysis = object(item.analysis);
  const sources = [item, analysis, object(item.execution), object(item.quote)];
  const bid = numeric(first(sources, ['bid', 'currentBid', 'bidPrice']));
  const ask = numeric(first(sources, ['ask', 'currentAsk', 'askPrice']));
  const mid = numeric(first(sources, ['currentPrice', 'price', 'mid', 'midPrice', 'entry', 'entryPrice', 'fillPrice'])) ??
    (bid != null && ask != null ? (bid + ask) / 2 : null);
  return {
    bid,
    ask,
    mid,
    spreadPips: numeric(first(sources, ['spreadPips', 'spread', 'currentSpreadPips'])),
  };
}

export function buildLearningRecords({
  userId,
  brokerAccountId,
  environment = 'unknown',
  engine,
  scanMode = 'full',
  runId,
  payload,
  observedAt = new Date(),
} = {}) {
  const now = observedAt instanceof Date ? observedAt : new Date(observedAt);
  const et = nyParts(now);
  const observations = [];
  const snapshots = new Map();

  collectScanCandidates(payload).forEach(({ item, sourceBucket, defaultStatus, sourceIndex }) => {
    const analysis = object(item.analysis);
    const marketRegime = object(item.marketRegime);
    const dailyStudy = object(item.dailyStudyContext);
    const pair = normalizePair(first([item, analysis], ['pair', 'instrument', 'symbol']));
    if (!pair) return;
    const direction = normalizeDirection(first([item, analysis], ['direction', 'side', 'signal']));
    const prices = priceFields(item);
    const confirmations = confirmationMap(item);
    const signatureKeys = Object.keys(confirmations).sort().slice(0, 12);
    const status = explicitStatus(item, defaultStatus);
    const observationKey = `${runId || now.toISOString()}:${engine}:${sourceBucket}:${sourceIndex}:${pair}:${direction || 'none'}`;
    const session = String(first([item, analysis], ['session', 'entrySession']) || inferSession(et.minuteOfDay));

    observations.push({
      observation_key: observationKey,
      user_id: String(userId),
      broker_account_id: String(brokerAccountId),
      environment: String(environment || 'unknown'),
      engine: String(engine || '').toLowerCase(),
      pair,
      direction,
      observed_at: now.toISOString(),
      ny_date: et.date,
      ny_minute: et.minuteOfDay,
      time_bucket_15m: et.bucket15m,
      session,
      run_id: runId || null,
      scan_mode: scanMode,
      source_bucket: sourceBucket,
      status,
      rejection_reason: String(first([item, analysis], ['rejectionReason', 'reason', 'skipReason', 'blockedReason']) || '') || null,
      confidence: numeric(first([item, analysis], ['baseConfidence', 'confidence'])),
      adjusted_confidence: numeric(first([item, analysis], ['confidence', 'adjustedConfidence'])),
      signal_score: numeric(first([item, analysis], ['signalScore', 'score'])),
      entry_price: numeric(first([item, analysis], ['entry', 'entryPrice', 'fillPrice', 'currentPrice', 'price'])),
      stop_loss: numeric(first([item, analysis], ['stopLoss', 'sl', 'structuralStop'])),
      take_profit: numeric(first([item, analysis], ['takeProfit', 'targetProfit', 'tp', 'target'])),
      projected_rr: numeric(first([item, analysis], ['expectedRR', 'rr', 'riskReward'])),
      spread_pips: prices.spreadPips,
      atr_pips: numeric(first([item, analysis], ['atrPips', 'atr'])),
      market_regime: String(first([item, analysis, marketRegime], ['regime', 'marketRegime', 'state']) || '') || null,
      volatility: String(first([item, analysis, marketRegime], ['volatility', 'volatilityState']) || '') || null,
      daily_direction: String(first([item, analysis, dailyStudy], ['dailyDirection', 'dayDirection', 'day_direction']) || '') || null,
      h4_direction: String(first([item, analysis], ['h4Direction', 'h4Trend']) || '') || null,
      h1_direction: String(first([item, analysis], ['h1Direction', 'h1Trend']) || '') || null,
      m15_direction: String(first([item, analysis], ['m15Direction', 'm15Trend']) || '') || null,
      m5_direction: String(first([item, analysis], ['m5Direction', 'm5Trend']) || '') || null,
      liquidity_context: object(first([item, analysis], ['liquidityContext', 'liquidity', 'institutionalFlow'])),
      confirmations,
      confirmation_signature: signatureKeys.length ? signatureKeys.join('+') : 'none',
      missing_confirmations: missingConfirmations(item),
      daily_study: Object.keys(dailyStudy).length ? dailyStudy : null,
      feature_snapshot: {
        setupType: first([item, analysis], ['setupType', 'strategy']),
        timing: first([item, analysis], ['timing']),
        manipulation: first([item, analysis], ['manipulation']),
        quality: first([item, analysis], ['quality', 'grade']),
      },
      raw_payload: item,
    });

    if (prices.mid != null) {
      const snapshotKey = `${runId || now.toISOString()}:${engine}:${pair}`;
      snapshots.set(pair, {
        snapshot_key: snapshotKey,
        user_id: String(userId),
        broker_account_id: String(brokerAccountId),
        environment: String(environment || 'unknown'),
        engine: String(engine || '').toLowerCase(),
        pair,
        observed_at: now.toISOString(),
        bid: prices.bid,
        ask: prices.ask,
        mid_price: prices.mid,
        spread_pips: prices.spreadPips,
        source_run_id: runId || null,
        raw_payload: { sourceBucket, scanMode },
      });
    }
  });

  return { observations, snapshots: [...snapshots.values()] };
}

function pipSize(pair) {
  return String(pair || '').endsWith('_JPY') ? 0.01 : 0.0001;
}

export function gradeObservation({ observation, snapshots, horizonMinutes }) {
  const horizon = Number(horizonMinutes);
  if (!HORIZONS.includes(horizon)) return null;
  const observedAt = Date.parse(observation?.observed_at);
  const dueAt = observedAt + horizon * 60_000;
  if (!Number.isFinite(observedAt) || Date.now() < dueAt) return null;

  const entry = numeric(observation?.entry_price);
  const stop = numeric(observation?.stop_loss);
  const target = numeric(observation?.take_profit);
  const direction = normalizeDirection(observation?.direction);
  const riskDistance = entry != null && stop != null ? Math.abs(entry - stop) : 0;
  if (entry == null || !direction || riskDistance <= 0) return null;

  const relevant = (Array.isArray(snapshots) ? snapshots : [])
    .filter((snapshot) => {
      const time = Date.parse(snapshot?.observed_at);
      return Number.isFinite(time) && time >= observedAt && time <= dueAt;
    })
    .sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
  if (!relevant.length) return null;

  const prices = relevant.map((snapshot) => numeric(snapshot.mid_price)).filter((price) => price != null);
  if (!prices.length) return null;
  const maximum = Math.max(...prices);
  const minimum = Math.min(...prices);
  const last = prices.at(-1);
  const favorablePrice = direction === 'long' ? maximum : minimum;
  const adversePrice = direction === 'long' ? minimum : maximum;
  const maxR = direction === 'long' ? (favorablePrice - entry) / riskDistance : (entry - favorablePrice) / riskDistance;
  const minR = direction === 'long' ? (adversePrice - entry) / riskDistance : (entry - adversePrice) / riskDistance;
  const realizedR = direction === 'long' ? (last - entry) / riskDistance : (entry - last) / riskDistance;

  const targetIndex = target == null ? -1 : relevant.findIndex((snapshot) => {
    const price = numeric(snapshot.mid_price);
    return price != null && (direction === 'long' ? price >= target : price <= target);
  });
  const stopIndex = relevant.findIndex((snapshot) => {
    const price = numeric(snapshot.mid_price);
    return price != null && (direction === 'long' ? price <= stop : price >= stop);
  });
  const targetHit = targetIndex >= 0;
  const stopHit = stopIndex >= 0;
  const targetFirst = targetHit && (!stopHit || targetIndex < stopIndex);
  const stopFirst = stopHit && (!targetHit || stopIndex < targetIndex);

  let result = 'breakeven';
  if (targetFirst) result = 'win';
  else if (stopFirst) result = 'loss';
  else if (realizedR > 0.05) result = 'win';
  else if (realizedR < -0.05) result = 'loss';

  let entryTiming = 'unknown';
  if (stopFirst && targetHit) entryTiming = 'early';
  else if (maxR >= 1 && minR > -0.35) entryTiming = 'optimal';
  else if (maxR >= 0.5 && minR > -0.75) entryTiming = 'acceptable';
  else if (maxR < 0.5 && minR <= -0.75) entryTiming = 'poor';
  else if (realizedR > 0 && maxR > 1.5 && realizedR < 0.25) entryTiming = 'late';

  const pip = pipSize(observation?.pair);
  return {
    observation_id: observation.id,
    horizon_minutes: horizon,
    graded_at: new Date().toISOString(),
    snapshot_count: relevant.length,
    horizon_price: last,
    max_favorable_price: favorablePrice,
    max_adverse_price: adversePrice,
    mfe_pips: Math.abs(favorablePrice - entry) / pip,
    mae_pips: Math.abs(adversePrice - entry) / pip,
    max_r: maxR,
    min_r: minR,
    realized_r: targetFirst ? (numeric(observation.projected_rr) ?? maxR) : stopFirst ? -1 : realizedR,
    target_hit: targetHit,
    stop_hit: stopHit,
    target_hit_at: targetHit ? relevant[targetIndex].observed_at : null,
    stop_hit_at: stopHit ? relevant[stopIndex].observed_at : null,
    direction_correct: maxR > Math.abs(Math.min(0, minR)),
    entry_timing: entryTiming,
    result,
    raw_payload: { targetFirst, stopFirst, riskDistance },
  };
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rankPositive(rows, minimum, limit = 5) {
  return [...rows]
    .filter((row) => numberValue(row.outcomes) >= minimum && numberValue(row.expectancy_r) > 0)
    .sort((a, b) => numberValue(b.expectancy_r) - numberValue(a.expectancy_r) || numberValue(b.win_rate) - numberValue(a.win_rate))
    .slice(0, limit);
}

export function buildPairPlaybook({ pair, engine, summary, timeStats = [], confirmationStats = [], comboStats = [], regimeStats = [] }, options = {}) {
  const displayMinimum = numberValue(options.displayMinimum, 10);
  const limitedMinimum = numberValue(options.limitedMinimum, 30);
  const calibrationMinimum = numberValue(options.calibrationMinimum, 50);
  const outcomes = numberValue(summary?.outcomes);
  const stage = outcomes < displayMinimum
    ? 'display_only'
    : outcomes < limitedMinimum
      ? 'shadow'
      : outcomes < calibrationMinimum
        ? 'limited_ready'
        : 'calibration_ready';

  const preferredWindows = rankPositive(timeStats, Math.max(5, Math.floor(limitedMinimum / 3)), 4)
    .map((row) => ({
      session: row.session,
      timeBucketEt: row.time_bucket_15m,
      direction: row.direction,
      outcomes: numberValue(row.outcomes),
      winRate: numberValue(row.win_rate),
      expectancyR: numberValue(row.expectancy_r),
      profitFactor: numberValue(row.profit_factor),
    }));

  const valuableConfirmations = [...confirmationStats]
    .filter((row) => numberValue(row.outcomes) >= limitedMinimum && numberValue(row.expectancy_lift_r) >= 0.1 && numberValue(row.expectancy_r) > 0)
    .sort((a, b) => numberValue(b.expectancy_lift_r) - numberValue(a.expectancy_lift_r))
    .slice(0, 8)
    .map((row) => ({
      confirmation: row.confirmation,
      outcomes: numberValue(row.outcomes),
      winRate: numberValue(row.win_rate),
      expectancyR: numberValue(row.expectancy_r),
      liftR: numberValue(row.expectancy_lift_r),
    }));

  const weakConfirmations = [...confirmationStats]
    .filter((row) => numberValue(row.outcomes) >= limitedMinimum && numberValue(row.expectancy_lift_r) <= 0)
    .sort((a, b) => numberValue(a.expectancy_lift_r) - numberValue(b.expectancy_lift_r))
    .slice(0, 8)
    .map((row) => ({
      confirmation: row.confirmation,
      outcomes: numberValue(row.outcomes),
      expectancyR: numberValue(row.expectancy_r),
      liftR: numberValue(row.expectancy_lift_r),
    }));

  const strongCombinations = rankPositive(comboStats, limitedMinimum, 6).map((row) => ({
    signature: row.confirmation_signature,
    outcomes: numberValue(row.outcomes),
    winRate: numberValue(row.win_rate),
    expectancyR: numberValue(row.expectancy_r),
    profitFactor: numberValue(row.profit_factor),
  }));

  const avoidConditions = [...regimeStats]
    .filter((row) => numberValue(row.outcomes) >= limitedMinimum && numberValue(row.expectancy_r) < 0)
    .sort((a, b) => numberValue(a.expectancy_r) - numberValue(b.expectancy_r))
    .slice(0, 8)
    .map((row) => ({
      direction: row.direction,
      marketRegime: row.market_regime,
      volatility: row.volatility,
      dailyDirection: row.daily_direction,
      h4Direction: row.h4_direction,
      outcomes: numberValue(row.outcomes),
      expectancyR: numberValue(row.expectancy_r),
    }));

  return {
    pair,
    engine,
    stage,
    status: stage === 'display_only' ? 'display_only' : 'shadow',
    sampleSize: outcomes,
    wins: numberValue(summary?.wins),
    losses: numberValue(summary?.losses),
    winRate: numeric(summary?.win_rate),
    expectancyR: numeric(summary?.expectancy_r),
    profitFactor: numeric(summary?.profit_factor),
    preferredWindows,
    valuableConfirmations,
    weakConfirmations,
    strongCombinations,
    avoidConditions,
    safeguards: {
      liveThresholdsChanged: false,
      maxConfidenceAdjustment: 0,
      riskBypass: false,
      rrBypass: false,
      spreadBypass: false,
      newsBypass: false,
      accountScoped: true,
    },
  };
}

export { HORIZONS };
