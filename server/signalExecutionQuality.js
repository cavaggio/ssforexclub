const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function finiteNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundQuarter(value) {
  return Math.round(value * 4) / 4;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalized(value) {
  const text = String(value || '').trim().toLowerCase();
  return text || null;
}

function normalizeDirection(value) {
  const direction = normalized(value);
  if (['long', 'buy', 'bullish'].includes(direction)) return 'long';
  if (['short', 'sell', 'bearish'].includes(direction)) return 'short';
  return null;
}

function evidenceWeight(outcomes, minimum, fullWeightMinimum) {
  const count = finiteNumber(outcomes, 0);
  if (count < minimum) return 0;
  if (fullWeightMinimum <= minimum) return 1;
  return clamp((count - minimum) / (fullWeightMinimum - minimum), 0.25, 1);
}

function addPenalty(reasons, amount, reason) {
  if (!(amount < 0)) return 0;
  reasons.push({ amount: roundQuarter(amount), reason });
  return amount;
}

/**
 * Scores entry/fill quality separately from the directional thesis.
 * This is deliberately advisory: it never creates a new execution hard gate.
 * Existing R:R, spread, fresh-price geometry, risk, margin, news, duplicate,
 * drawdown, and broker authorization gates remain authoritative.
 */
export function assessCandidateExecutionQuality(candidate = {}) {
  const analysis = object(candidate.analysis);
  const timing = object(candidate.timing || analysis.timing);
  const targetConfidence = object(candidate.targetConfidence || analysis.targetConfidence);
  const concepts = object(candidate.concepts || analysis.concepts);
  const premiumDiscount = object(
    candidate.premiumDiscount || analysis.premiumDiscount || concepts.premiumDiscount,
  );
  const sweep = object(candidate.sweep || analysis.sweep || concepts.sweep);
  const direction = normalizeDirection(
    candidate.direction || candidate.side || candidate.signal || analysis.direction || analysis.signal,
  );

  const timingGrade = String(
    timing.timingGrade || candidate.timingGrade || targetConfidence.timingGrade || '',
  ).trim().toUpperCase() || null;
  const lateEntryRisk = normalized(
    timing.lateEntryRisk || candidate.lateEntryRisk || targetConfidence.lateEntryRisk,
  );
  const locationZone = normalized(
    premiumDiscount.currentZone || candidate.locationZone || analysis.locationZone,
  );
  const sweepPending = Boolean(sweep.pending === true || normalized(sweep.subtype) === 'pending_sweep');
  const entryDriftAtr = finiteNumber(
    candidate.entryDriftAtr ?? analysis.entryDriftAtr ?? targetConfidence.entryDriftAtr,
  );
  const rewardConsumedFraction = finiteNumber(
    candidate.rewardConsumedFraction ?? analysis.rewardConsumedFraction ?? targetConfidence.rewardConsumedFraction,
  );
  const priceInsideEntryZone = candidate.priceInsideEntryZone ?? analysis.priceInsideEntryZone ??
    targetConfidence.priceInsideEntryZone ?? null;
  const actualRR = finiteNumber(
    candidate.actualRR ?? analysis.actualRR ?? targetConfidence.actualRR ?? candidate.rr ?? candidate.expectedRR,
  );

  const adverseLocation = Boolean(
    (direction === 'long' && locationZone === 'premium') ||
    (direction === 'short' && locationZone === 'discount')
  );

  const reasons = [];
  let adjustment = 0;

  if (timingGrade === 'D') adjustment += addPenalty(reasons, -0.75, 'Timing grade D indicates weak entry efficiency.');
  else if (timingGrade === 'C') adjustment += addPenalty(reasons, -0.25, 'Timing grade C indicates moderate entry inefficiency.');

  if (lateEntryRisk === 'high') adjustment += addPenalty(reasons, -0.75, 'Late-entry risk is high.');
  else if (lateEntryRisk === 'medium') adjustment += addPenalty(reasons, -0.25, 'Late-entry risk is medium.');

  if (adverseLocation) {
    adjustment += addPenalty(
      reasons,
      -0.5,
      direction === 'long'
        ? 'Long entry is already in premium.'
        : 'Short entry is already in discount.',
    );
  }

  if (sweepPending) adjustment += addPenalty(reasons, -0.25, 'Liquidity sweep is pending rather than confirmed.');

  if (entryDriftAtr != null) {
    if (entryDriftAtr > 0.5) adjustment += addPenalty(reasons, -0.5, 'Executable price drift exceeds 0.50 ATR from the modeled entry.');
    else if (entryDriftAtr > 0.25) adjustment += addPenalty(reasons, -0.25, 'Executable price drift exceeds 0.25 ATR from the modeled entry.');
  }

  if (rewardConsumedFraction != null) {
    if (rewardConsumedFraction > 0.35) adjustment += addPenalty(reasons, -0.5, 'More than 35% of the modeled reward has already been consumed.');
    else if (rewardConsumedFraction > 0.15) adjustment += addPenalty(reasons, -0.25, 'More than 15% of the modeled reward has already been consumed.');
  }

  if (priceInsideEntryZone === false) {
    adjustment += addPenalty(reasons, -0.25, 'Executable price is outside the modeled entry zone.');
  }

  return {
    dimension: 'execution_quality',
    direction,
    timingGrade,
    lateEntryRisk,
    locationZone,
    adverseLocation,
    sweepPending,
    entryDriftAtr,
    rewardConsumedFraction,
    priceInsideEntryZone,
    actualRR,
    adjustment: roundQuarter(clamp(adjustment, -2.5, 0)),
    reasons,
    advisoryOnly: true,
    createsHardGate: false,
  };
}

function isExecutionComponent(component = {}) {
  return component.qualityDimension === 'execution' ||
    ['entry_execution_quality', 'execution_quality', 'fill_execution_quality'].includes(String(component.name || ''));
}

/**
 * Keeps historical thesis evidence and entry/fill evidence in separate channels.
 * Signal quality may calibrate the engine's directional confidence. Execution
 * quality calibrates entryQualityConfidence only and never becomes a new gate.
 */
export function separateSignalAndExecutionLearning({
  engineResult = {},
  candidate = {},
  options = {},
} = {}) {
  const components = Array.isArray(engineResult.components) ? engineResult.components : [];
  const signalComponents = components.filter((item) => !isExecutionComponent(item));
  const historicalExecutionComponents = components.filter(isExecutionComponent);
  const rawSignalAdjustment = roundQuarter(clamp(
    signalComponents.reduce((sum, item) => sum + finiteNumber(item.adjustment, 0), 0),
    -3,
    3,
  ));
  const rawHistoricalExecutionAdjustment = roundQuarter(clamp(
    historicalExecutionComponents.reduce((sum, item) => sum + finiteNumber(item.adjustment, 0), 0),
    -1.5,
    1,
  ));

  const displayMinimum = Math.max(1, finiteNumber(options.displayMinimum, 10));
  const liveMinimum = Math.max(displayMinimum, finiteNumber(options.liveMinimum, 30));
  const fullWeightMinimum = Math.max(liveMinimum, finiteNumber(options.fullWeightMinimum, 100));
  const sampleSize = finiteNumber(engineResult.sampleSize, 0);
  const mode = normalized(engineResult.mode || options.mode) || 'limited';
  const liveEligible = ['limited', 'active'].includes(mode) && sampleSize >= liveMinimum;
  const sampleWeight = liveEligible
    ? evidenceWeight(sampleSize, liveMinimum, fullWeightMinimum)
    : 0;

  const appliedSignalAdjustment = liveEligible
    ? roundQuarter(clamp(rawSignalAdjustment * sampleWeight, -3, 3))
    : 0;
  const appliedHistoricalExecutionAdjustment = liveEligible
    ? roundQuarter(clamp(rawHistoricalExecutionAdjustment * sampleWeight, -1.5, 1))
    : 0;

  const candidateExecution = assessCandidateExecutionQuality(candidate);
  const appliedExecutionAdjustment = roundQuarter(clamp(
    appliedHistoricalExecutionAdjustment + candidateExecution.adjustment,
    -3,
    1,
  ));

  return {
    signalQuality: {
      rawAdjustment: rawSignalAdjustment,
      appliedAdjustment: appliedSignalAdjustment,
      components: signalComponents,
      confidencePurpose: 'directional_thesis_and_target_probability',
    },
    executionQuality: {
      rawHistoricalAdjustment: rawHistoricalExecutionAdjustment,
      appliedHistoricalAdjustment: appliedHistoricalExecutionAdjustment,
      currentCandidateAdjustment: candidateExecution.adjustment,
      appliedAdjustment: appliedExecutionAdjustment,
      historicalComponents: historicalExecutionComponents,
      currentCandidate: candidateExecution,
      confidencePurpose: 'entry_and_fill_efficiency',
      advisoryOnly: true,
      createsHardGate: false,
    },
    sampleSize,
    sampleWeight,
    liveEligible,
    separated: true,
  };
}
