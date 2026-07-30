const SUPPORTED_ENGINES = new Set(['ict', 'ppr', 'v3']);

function finiteNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function roundQuarter(value) {
  return Math.round(value * 4) / 4;
}

function normalizeEngine(value) {
  const engine = String(value || '').trim().toLowerCase();
  return SUPPORTED_ENGINES.has(engine) ? engine : null;
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

function normalizeKey(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function candidateConfirmations(candidate = {}) {
  const sources = [candidate.confirmations, candidate.analysis?.confirmations]
    .filter((value) => value && typeof value === 'object' && !Array.isArray(value));
  const values = new Set();
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value === true || value === 1 || ['true', 'yes', 'confirmed', 'present', 'valid'].includes(String(value).toLowerCase())) {
        values.add(normalizeKey(key));
      }
    }
  }
  for (const label of [
    ...(Array.isArray(candidate.conceptsDetected) ? candidate.conceptsDetected : []),
    ...(Array.isArray(candidate.analysis?.conceptsDetected) ? candidate.analysis.conceptsDetected : []),
  ]) values.add(normalizeKey(label));
  return values;
}

function candidateContext(candidate = {}) {
  const analysis = candidate.analysis && typeof candidate.analysis === 'object' ? candidate.analysis : {};
  const dailyStudy = candidate.dailyStudyContext && typeof candidate.dailyStudyContext === 'object'
    ? candidate.dailyStudyContext
    : {};
  return {
    engine: normalizeEngine(candidate.engine || candidate.strategy || analysis.engine),
    pair: normalizePair(candidate.pair || candidate.instrument || candidate.symbol),
    direction: normalizeDirection(candidate.direction || candidate.side || candidate.signal || analysis.direction),
    session: String(candidate.session?.name || candidate.session || analysis.session?.name || analysis.session || '').trim().toLowerCase() || null,
    marketRegime: String(candidate.marketRegime?.regime || candidate.marketRegime || analysis.marketRegime || analysis.regime || '').trim().toLowerCase() || null,
    volatility: String(candidate.volatilityState || candidate.volatility || analysis.volatilityState || analysis.volatility || '').trim().toLowerCase() || null,
    dailyDirection: String(candidate.dailyDirection || dailyStudy.dayDirection || dailyStudy.day_direction || analysis.dailyDirection || '').trim().toLowerCase() || null,
    h4Direction: String(candidate.h4Direction || analysis.h4Direction || analysis.h4Trend || '').trim().toLowerCase() || null,
    confirmations: candidateConfirmations(candidate),
  };
}

function stageFor(sampleSize, { displayMinimum = 10, liveMinimum = 30, fullWeightMinimum = 100 } = {}) {
  if (sampleSize < displayMinimum) return 'display_only';
  if (sampleSize < liveMinimum) return 'shadow';
  if (sampleSize < fullWeightMinimum) return 'limited_ready';
  return 'calibration_ready';
}

function expectancySignal(expectancy, strong = 0.35, weak = 0.12) {
  const value = finiteNumber(expectancy, 0);
  if (value >= strong) return 1;
  if (value >= weak) return 0.6;
  if (value <= -strong) return -1;
  if (value <= -weak) return -0.6;
  return 0;
}

function evidenceWeight(outcomes, minimum, fullWeightMinimum) {
  const count = finiteNumber(outcomes, 0);
  if (count < minimum) return 0;
  if (fullWeightMinimum <= minimum) return 1;
  return clamp((count - minimum) / (fullWeightMinimum - minimum), 0.25, 1);
}

function normalizedText(value) {
  const text = String(value || '').trim().toLowerCase();
  return text || null;
}

function contextMatchScore(row, context) {
  const rules = [
    ['direction', context.direction, 5],
    ['session', context.session, 4],
    ['market_regime', context.marketRegime, 3],
    ['volatility', context.volatility, 2],
    ['daily_direction', context.dailyDirection, 2],
    ['h4_direction', context.h4Direction, 2],
  ];
  let score = 0;
  let compared = 0;
  for (const [field, actual, weight] of rules) {
    const expected = normalizedText(row?.[field]);
    if (!expected || !actual) continue;
    compared += 1;
    if (expected !== normalizedText(actual)) return -1;
    score += weight;
  }
  return compared ? score : 0;
}

function bestContextRow(rows, context, minimumOutcomes) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => finiteNumber(row?.outcomes, 0) >= minimumOutcomes)
    .map((row) => ({ row, score: contextMatchScore(row, context) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || finiteNumber(b.row.outcomes, 0) - finiteNumber(a.row.outcomes, 0))[0]?.row || null;
}

function component(name, adjustment, outcomes, expectancyR, reason, metadata = {}) {
  return {
    name,
    adjustment: roundQuarter(adjustment),
    outcomes: finiteNumber(outcomes, 0),
    expectancyR: finiteNumber(expectancyR, null),
    reason,
    ...metadata,
  };
}

/**
 * Computes a bounded, engine-isolated learning adjustment from completed,
 * executed-trade outcomes. It never changes risk, R:R, spread, news, margin,
 * duplicate-trade, daily-loss, or broker authorization gates.
 */
export function computeEngineTradeAdjustment(candidate = {}, profile = {}, options = {}) {
  const context = candidateContext(candidate);
  const profileEngine = normalizeEngine(profile.engine || profile.pairSummary?.engine);
  const profilePair = normalizePair(profile.pair || profile.pairSummary?.pair);
  const mode = ['off', 'shadow', 'limited', 'active'].includes(String(options.mode || '').toLowerCase())
    ? String(options.mode).toLowerCase()
    : 'limited';
  const displayMinimum = Math.max(1, finiteNumber(options.displayMinimum, 10));
  const liveMinimum = Math.max(displayMinimum, finiteNumber(options.liveMinimum, 30));
  const fullWeightMinimum = Math.max(liveMinimum, finiteNumber(options.fullWeightMinimum, 100));
  const segmentMinimum = Math.max(5, finiteNumber(options.segmentMinimum, 12));
  const confirmationMinimum = Math.max(5, finiteNumber(options.confirmationMinimum, 15));
  const maxAdjustment = clamp(finiteNumber(options.maxAdjustment, 3), 0, 3);
  const sampleSize = finiteNumber(profile.pairSummary?.outcomes ?? profile.sampleSize, 0);
  const stage = stageFor(sampleSize, { displayMinimum, liveMinimum, fullWeightMinimum });
  const scopeMatches = Boolean(
    context.engine && profileEngine && context.engine === profileEngine &&
    context.pair && profilePair && context.pair === profilePair
  );

  if (!scopeMatches) {
    return {
      mode,
      stage: 'scope_mismatch',
      sampleSize,
      rawAdjustment: 0,
      appliedAdjustment: 0,
      components: [],
      reasons: ['Engine/pair profile did not match the current trade candidate.'],
      scopeMatches: false,
      hardGatesPreserved: true,
      profileEngine,
      profilePair,
    };
  }

  const components = [];
  const pairSummary = profile.pairSummary || {};
  const pairSignal = expectancySignal(pairSummary.expectancy_r);
  if (sampleSize >= displayMinimum && pairSignal !== 0) {
    const weight = evidenceWeight(sampleSize, displayMinimum, fullWeightMinimum);
    components.push(component(
      'engine_pair_expectancy',
      pairSignal * 1.1 * weight,
      sampleSize,
      pairSummary.expectancy_r,
      `${profileEngine.toUpperCase()} ${profilePair} executed trades have ${pairSignal > 0 ? 'positive' : 'negative'} expectancy.`,
    ));
  }

  const matchedContext = bestContextRow(profile.contextStats, context, segmentMinimum);
  if (matchedContext) {
    const signal = expectancySignal(matchedContext.expectancy_r, 0.3, 0.1);
    if (signal !== 0) {
      const weight = evidenceWeight(matchedContext.outcomes, segmentMinimum, Math.max(segmentMinimum + 1, 60));
      components.push(component(
        'matching_trade_context',
        signal * 1.15 * weight,
        matchedContext.outcomes,
        matchedContext.expectancy_r,
        `Matching ${profileEngine.toUpperCase()} direction/session/regime evidence is ${signal > 0 ? 'supportive' : 'adverse'}.`,
        { matchedContext },
      ));
    }
  }

  const matchedConfirmations = (Array.isArray(profile.confirmationStats) ? profile.confirmationStats : [])
    .filter((row) => context.confirmations.has(normalizeKey(row?.confirmation)))
    .filter((row) => finiteNumber(row?.outcomes, 0) >= confirmationMinimum)
    .map((row) => {
      const lift = finiteNumber(row.expectancy_lift_r, 0);
      const signal = expectancySignal(lift, 0.2, 0.07);
      const weight = evidenceWeight(row.outcomes, confirmationMinimum, 60);
      return { row, adjustment: signal * 0.45 * weight };
    })
    .filter((entry) => entry.adjustment !== 0)
    .sort((a, b) => Math.abs(b.adjustment) - Math.abs(a.adjustment))
    .slice(0, 3);
  if (matchedConfirmations.length) {
    const total = clamp(matchedConfirmations.reduce((sum, entry) => sum + entry.adjustment, 0), -0.9, 0.9);
    components.push(component(
      'engine_confirmation_lift',
      total,
      Math.min(...matchedConfirmations.map((entry) => finiteNumber(entry.row.outcomes, 0))),
      null,
      `${matchedConfirmations.length} current confirmation(s) have measured ${total > 0 ? 'positive' : 'negative'} lift for this engine.`,
      { confirmations: matchedConfirmations.map((entry) => entry.row.confirmation) },
    ));
  }

  const quality = profile.executionQuality || {};
  const qualityOutcomes = finiteNumber(quality.outcomes, 0);
  if (qualityOutcomes >= segmentMinimum) {
    const poorRate = finiteNumber(quality.poor_or_early_rate, 0);
    const efficientRate = finiteNumber(quality.efficient_entry_rate, 0);
    if (poorRate >= 45) {
      components.push(component(
        'entry_execution_quality',
        -0.5 * evidenceWeight(qualityOutcomes, segmentMinimum, 60),
        qualityOutcomes,
        null,
        `${profileEngine.toUpperCase()} has a high poor/early-entry rate on this pair.`,
      ));
    } else if (efficientRate >= 65) {
      components.push(component(
        'entry_execution_quality',
        0.35 * evidenceWeight(qualityOutcomes, segmentMinimum, 60),
        qualityOutcomes,
        null,
        `${profileEngine.toUpperCase()} entry timing has been efficient on this pair.`,
      ));
    }
  }

  const rawAdjustment = roundQuarter(clamp(
    components.reduce((sum, item) => sum + finiteNumber(item.adjustment, 0), 0),
    -maxAdjustment,
    maxAdjustment,
  ));
  const sampleWeight = sampleSize < liveMinimum
    ? 0
    : evidenceWeight(sampleSize, liveMinimum, fullWeightMinimum);
  const liveEligible = (mode === 'limited' || mode === 'active') && sampleSize >= liveMinimum;
  const appliedAdjustment = liveEligible
    ? roundQuarter(clamp(rawAdjustment * sampleWeight, -maxAdjustment, maxAdjustment))
    : 0;

  return {
    mode,
    stage,
    sampleSize,
    rawAdjustment,
    appliedAdjustment,
    components,
    reasons: components.map((item) => item.reason),
    scopeMatches: true,
    liveEligible,
    hardGatesPreserved: true,
    profileEngine,
    profilePair,
    matchedContext,
  };
}

export function applyBoundedConfidence({
  originalConfidence,
  marketStudyAdjustment = 0,
  engineTradeAdjustment = 0,
  maxCombinedAdjustment = 5,
} = {}) {
  const original = finiteNumber(originalConfidence, null);
  if (original == null) {
    return {
      originalConfidence: null,
      marketStudyAdjustment: 0,
      engineTradeAdjustment: 0,
      combinedAdjustment: 0,
      finalConfidence: null,
    };
  }
  const market = clamp(finiteNumber(marketStudyAdjustment, 0), -2, 2);
  const engine = clamp(finiteNumber(engineTradeAdjustment, 0), -3, 3);
  const combined = roundQuarter(clamp(market + engine, -Math.abs(maxCombinedAdjustment), Math.abs(maxCombinedAdjustment)));
  return {
    originalConfidence: original,
    marketStudyAdjustment: market,
    engineTradeAdjustment: engine,
    combinedAdjustment: combined,
    finalConfidence: clamp(original + combined, 0, 100),
  };
}

export const ENGINE_TRADE_LEARNING_HARD_GATES = Object.freeze([
  'risk',
  'daily_drawdown',
  'rr',
  'spread',
  'news',
  'margin',
  'duplicate',
  'broker_authorization',
]);
