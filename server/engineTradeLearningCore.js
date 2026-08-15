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
  const pairSampleSize = finiteNumber(profile.pairSummary?.outcomes ?? profile.sampleSize, 0);
  const recentPairSampleSize = finiteNumber(profile.recentPairSummary7d?.outcomes, 0);
  const accountSampleSize = finiteNumber(profile.accountSummary7d?.outcomes, 0);
  const sampleSize = Math.max(pairSampleSize, recentPairSampleSize, accountSampleSize);
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
  const accountSummary7d = profile.accountSummary7d || {};
  const accountSignal = expectancySignal(accountSummary7d.expectancy_r, 0.25, 0.08);
  if (accountSampleSize >= displayMinimum && accountSignal !== 0) {
    const weight = evidenceWeight(accountSampleSize, displayMinimum, fullWeightMinimum);
    components.push(component(
      'engine_account_accuracy_7d',
      accountSignal * 0.75 * weight,
      accountSampleSize,
      accountSummary7d.expectancy_r,
      `${profileEngine.toUpperCase()} account-level accuracy over the latest seven trading days is ${accountSignal > 0 ? 'supportive' : 'adverse'}.`,
      { tradingDays: finiteNumber(accountSummary7d.trading_days, 0), winRate: finiteNumber(accountSummary7d.win_rate, null) },
    ));
  }

  const recentPairSummary7d = profile.recentPairSummary7d || {};
  const recentPairSignal = expectancySignal(recentPairSummary7d.expectancy_r, 0.3, 0.1);
  if (recentPairSampleSize >= displayMinimum && recentPairSignal !== 0) {
    const weight = evidenceWeight(recentPairSampleSize, displayMinimum, fullWeightMinimum);
    components.push(component(
      'engine_pair_accuracy_7d',
      recentPairSignal * 0.65 * weight,
      recentPairSampleSize,
      recentPairSummary7d.expectancy_r,
      `${profileEngine.toUpperCase()} ${profilePair} recent seven-trading-day expectancy is ${recentPairSignal > 0 ? 'positive' : 'negative'}.`,
    ));
  }

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

  // Broad market scans include qualified, watching, near-qualified, late and
  // rejected observations. They are supplemental evidence only: actual broker
  // P&L/R above remains primary and every hard execution gate stays intact.
  const signalQuality = profile.signalQuality || {};
  const signalOutcomes = finiteNumber(signalQuality.outcomes, 0);
  const timingOutcomes = finiteNumber(signalQuality.timing_outcomes, 0);
  const lateOrPoorRate = finiteNumber(signalQuality.late_or_poor_rate, 0);
  if (timingOutcomes >= segmentMinimum && lateOrPoorRate >= 35) {
    components.push(component(
      'market_scan_entry_timing',
      -0.5 * evidenceWeight(timingOutcomes, segmentMinimum, 80),
      timingOutcomes,
      null,
      `${profileEngine.toUpperCase()} market scans show excessive late/poor entry timing on this pair.`,
      { lateOrPoorRate },
    ));
  }

  const missedOutcomes = finiteNumber(signalQuality.actionable_nonexecuted_outcomes, 0);
  const missedExpectancy = finiteNumber(signalQuality.actionable_nonexecuted_expectancy_r, null);
  const missedWinnerRate = finiteNumber(signalQuality.missed_winner_rate, 0);
  if (missedOutcomes >= segmentMinimum && missedExpectancy != null) {
    const missedSignal = expectancySignal(missedExpectancy, 0.3, 0.12);
    if (missedSignal !== 0) {
      const weight = evidenceWeight(missedOutcomes, segmentMinimum, 80);
      const magnitude = missedSignal > 0 ? 0.45 : 0.35;
      components.push(component(
        'market_scan_missed_opportunity',
        missedSignal * magnitude * weight,
        missedOutcomes,
        missedExpectancy,
        missedSignal > 0
          ? `${profileEngine.toUpperCase()} actionable non-executed scans contain repeat missed winners on this pair.`
          : `${profileEngine.toUpperCase()} actionable non-executed scans have negative expectancy on this pair.`,
        { missedWinnerRate, totalSignalOutcomes: signalOutcomes },
      ));
    }
  }

  // Audit effectiveness is deliberately a small trust modifier. It asks whether
  // previously applied adjustments aligned with exact linked broker outcomes;
  // it cannot independently qualify a trade or weaken a hard gate.
  const effectiveness = profile.adjustmentEffectiveness || {};
  const adjustedOutcomes = finiteNumber(effectiveness.adjusted_outcomes, 0);
  const alignmentRate = finiteNumber(effectiveness.adjustment_alignment_rate, null);
  const adjustedExpectancy = finiteNumber(effectiveness.adjusted_expectancy_r, null);
  if (adjustedOutcomes >= confirmationMinimum && alignmentRate != null) {
    const weight = evidenceWeight(adjustedOutcomes, confirmationMinimum, 80);
    if (alignmentRate < 45 || (adjustedExpectancy != null && adjustedExpectancy <= -0.1)) {
      components.push(component(
        'applied_adjustment_effectiveness',
        -0.5 * weight,
        adjustedOutcomes,
        adjustedExpectancy,
        `${profileEngine.toUpperCase()} applied confidence adjustments have not aligned with actual broker outcomes.`,
        { alignmentRate },
      ));
    } else if (alignmentRate >= 60 && adjustedExpectancy != null && adjustedExpectancy >= 0.1) {
      components.push(component(
        'applied_adjustment_effectiveness',
        0.25 * weight,
        adjustedOutcomes,
        adjustedExpectancy,
        `${profileEngine.toUpperCase()} applied confidence adjustments are aligning with actual broker outcomes.`,
        { alignmentRate },
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
    pairSampleSize,
    recentPairSampleSize,
    accountSampleSize,
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
