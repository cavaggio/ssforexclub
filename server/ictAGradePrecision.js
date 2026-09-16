import { createClient } from '@supabase/supabase-js';

const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, value));
const finite = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const clean = (value) => String(value ?? '').trim();
const truthy = (value) => ['1', 'true', 'yes', 'on'].includes(clean(value).toLowerCase());

function normalizedDirection(value) {
  const v = clean(value).toLowerCase();
  if (['buy', 'long', 'bullish'].includes(v)) return 'bullish';
  if (['sell', 'short', 'bearish'].includes(v)) return 'bearish';
  return null;
}

function entryFamily(analysis = {}) {
  const explicit = clean(analysis?.correctiveGate?.family).toLowerCase();
  if (explicit === 'continuation' || explicit === 'reversal') return explicit;
  const mode = clean(analysis?.entryAuthorization?.mode).toLowerCase();
  if (mode.startsWith('initial_reversal_')) return 'reversal';
  if (mode === 'h1_transition' || mode.startsWith('m5_continuation_')) return 'continuation';
  return null;
}

function reversalSequence(analysis = {}) {
  const model = analysis?.marketMakerModel || {};
  const cycle = model?.cycle || {};
  const observation = model?.observation || {};
  const concepts = analysis?.concepts || {};
  return {
    keyTap: model?.keyLevelTap?.aligned === true || Boolean(cycle?.keyLevel?.tappedAt),
    liquiditySweep: observation?.sweepAligned === true || Boolean(cycle?.manipulation?.time),
    displacement: observation?.displacementFresh === true || Boolean(cycle?.displacement?.time),
    reversalConfirm: observation?.mssAligned === true ||
      observation?.cisd?.confirmed === true ||
      observation?.inverseFvg?.confirmed === true ||
      concepts?.mss?.confirmed === true ||
      concepts?.cisd?.confirmed === true,
  };
}

export function ictAGradeConfig(env = process.env) {
  return {
    required: env.ICT_A_GRADE_REQUIRED == null ? true : truthy(env.ICT_A_GRADE_REQUIRED),
    minimumScore: clamp(finite(env.ICT_A_GRADE_MIN_SCORE, 80), 70, 95),
    maximumTriggerAgeBars: clamp(finite(env.ICT_A_GRADE_MAX_TRIGGER_AGE_BARS, 1), 0, 2),
    maximumEntryDriftAtr: Math.max(0.10, finite(env.ICT_A_GRADE_MAX_ENTRY_DRIFT_ATR, 0.35)),
    maximumRewardConsumedFraction: Math.max(0.05, finite(env.ICT_A_GRADE_MAX_REWARD_CONSUMED, 0.25)),
    minimumTimingScore: clamp(finite(env.ICT_A_GRADE_MIN_TIMING_SCORE, 80), 60, 100),
    maximumExhaustionRisk: clamp(finite(env.ICT_A_GRADE_MAX_EXHAUSTION_RISK, 39), 10, 80),
  };
}

export function computeIctExhaustionRisk(analysis = {}, targetConfidence = null) {
  const family = entryFamily(analysis);
  const momentum = analysis?.h1Momentum || {};
  const age = finite(analysis?.triggerAgeBars ?? targetConfidence?.triggerAgeBars);
  const drift = finite(targetConfidence?.entryDriftAtr, 0);
  const consumed = finite(targetConfidence?.rewardConsumedFraction, 0);
  const timingScore = finite(targetConfidence?.timingScore, 100);
  let risk = 0;
  const reasons = [];

  if (family === 'continuation' && momentum?.currentOpposing === true) {
    risk += 55;
    reasons.push('live H1 candle is actively opposing the continuation');
  }
  if (family === 'continuation' && momentum?.exhausted === true) {
    risk += 35;
    reasons.push('H1 continuation momentum is exhausted');
  }
  if (age == null) {
    risk += 35;
    reasons.push('M5 trigger age is unknown');
  } else if (age >= 2) {
    risk += 35;
    reasons.push(`M5 trigger is ${age} bars old`);
  } else if (age >= 1) {
    risk += 15;
    reasons.push('M5 trigger is one bar old');
  }

  if (targetConfidence) {
    if (drift > 0.15) {
      const add = Math.min(30, Math.round((drift - 0.15) * 60));
      risk += add;
      if (add > 0) reasons.push(`entry drift is ${drift.toFixed(2)} ATR from the ideal entry`);
    }
    if (consumed > 0.08) {
      const add = Math.min(30, Math.round((consumed - 0.08) * 80));
      risk += add;
      if (add > 0) reasons.push(`${Math.round(consumed * 100)}% of the planned reward path is already consumed`);
    }
    if (targetConfidence?.priceInsideEntryZone === false) {
      risk += 30;
      reasons.push('current executable price is outside the intended entry zone');
    }
    if (timingScore < 80) {
      risk += Math.min(25, Math.round((80 - timingScore) * 0.6));
      reasons.push(`execution timing score has fallen to ${Math.round(timingScore)}`);
    }
  }

  return { score: clamp(Math.round(risk)), reasons };
}

export function evaluateIctAGradeSetup(analysis = {}, {
  targetConfidence = null,
  stage = 'scanner',
  config = ictAGradeConfig(),
} = {}) {
  const family = entryFamily(analysis);
  const timeframe = analysis?.timeframeBias || {};
  const momentum = analysis?.h1Momentum || {};
  const transition = analysis?.h1Transition || {};
  const auth = analysis?.entryAuthorization || {};
  const correctiveGate = analysis?.correctiveGate || {};
  const model = analysis?.marketMakerModel || {};
  const rr = finite(targetConfidence?.actualRR ?? analysis?.rr, 0);
  const confidence = finite(targetConfidence?.confidence ?? analysis?.confidence, 0);
  const triggerAge = finite(analysis?.triggerAgeBars ?? targetConfidence?.triggerAgeBars);
  const exhaustion = computeIctExhaustionRisk(analysis, targetConfidence);
  const reversal = reversalSequence(analysis);
  const blockers = [];

  const authReady = auth?.ready === true && Boolean(auth?.cycleId);
  const correctiveReady = correctiveGate?.passed === true && correctiveGate?.decision === 'authorize';
  const m5Ready = analysis?.entryTimeframe === '5M' && analysis?.entryCandle?.triggerReady === true && analysis?.freshImpulse === true;
  const triggerFreshEnough = triggerAge != null && triggerAge <= config.maximumTriggerAgeBars;
  const studyDistribution = model?.studyReady === true && model?.stage === 'DISTRIBUTION_ACTIVE';

  if (!family) blockers.push('entry family is not continuation or reversal');
  if (!authReady) blockers.push('central entry authorization is not ready');
  if (!correctiveReady) blockers.push('corrective gate is not authorized');
  if (!m5Ready) blockers.push('fresh M5 execution trigger is not ready');
  if (!triggerFreshEnough) blockers.push(`M5 trigger age exceeds A-grade maximum of ${config.maximumTriggerAgeBars} bar(s)`);
  if (!studyDistribution) blockers.push('persistent PO3 cycle is not in DISTRIBUTION_ACTIVE');
  if (!(confidence >= 75)) blockers.push(`confidence ${confidence}% is below the 75% ICT floor`);
  if (!(rr >= 1.5)) blockers.push(`R:R ${rr.toFixed(2)} is below 1.50`);

  let structuralQuality = 0;
  if (correctiveReady) structuralQuality += 8;
  if (authReady) structuralQuality += 6;

  if (family === 'continuation') {
    const wanted = normalizedDirection(analysis?.signal || analysis?.ictBias);
    const d1 = normalizedDirection(timeframe?.d1);
    const h4 = normalizedDirection(timeframe?.h4);
    const htfAligned = Boolean(wanted && d1 === wanted && h4 === wanted && timeframe?.d1H4Aligned !== false);
    const h1Aligned = momentum?.currentAligned === true || momentum?.activeAligned === true ||
      momentum?.aligned === true || (transition?.ready === true && normalizedDirection(transition?.bias) === wanted);
    if (htfAligned) structuralQuality += 8;
    if (h1Aligned) structuralQuality += 6;
    if (momentum?.currentOpposing !== true && momentum?.exhausted !== true) structuralQuality += 2;
    if (!htfAligned) blockers.push('continuation D1/H4 direction is not aligned');
    if (!h1Aligned) blockers.push('continuation H1 active momentum/transition is not aligned');
    if (momentum?.currentOpposing === true || momentum?.exhausted === true) blockers.push('continuation H1 momentum is opposing or exhausted');
  } else if (family === 'reversal') {
    structuralQuality += [reversal.keyTap, reversal.liquiditySweep, reversal.displacement, reversal.reversalConfirm]
      .filter(Boolean).length * 4;
    if (!reversal.keyTap) blockers.push('reversal HTF key-level tap is missing');
    if (!reversal.liquiditySweep) blockers.push('reversal liquidity sweep is missing');
    if (!reversal.displacement) blockers.push('reversal opposing displacement is missing');
    if (!reversal.reversalConfirm) blockers.push('reversal CISD/MSS/iFVG confirmation is missing');
  }
  structuralQuality = clamp(structuralQuality, 0, 30);

  let freshnessQuality = 0;
  if (analysis?.freshImpulse === true) freshnessQuality += 7;
  if (analysis?.entryCandle?.triggerReady === true) freshnessQuality += 5;
  if (analysis?.entryTimeframe === '5M') freshnessQuality += 3;
  if (triggerAge === 0) freshnessQuality += 10;
  else if (triggerAge === 1) freshnessQuality += 7;
  else if (triggerAge === 2) freshnessQuality += 3;
  freshnessQuality = clamp(freshnessQuality, 0, 25);

  let liquidityQuality = 0;
  if (model?.studyReady === true) liquidityQuality += 5;
  if (model?.stage === 'DISTRIBUTION_ACTIVE') liquidityQuality += 10;
  if (family === 'reversal') {
    if (reversal.keyTap) liquidityQuality += 2;
    if (reversal.liquiditySweep) liquidityQuality += 3;
  } else {
    if (analysis?.continuationBreakout?.ready === true) liquidityQuality += 3;
    if (analysis?.continuationBreakout?.retestConfirmed === true || analysis?.continuationBreakout?.pullbackConfirmed === true) liquidityQuality += 2;
  }
  liquidityQuality = clamp(liquidityQuality, 0, 20);

  let executionQuality = 0;
  if (rr >= 1.8) executionQuality += 7;
  else if (rr >= 1.6) executionQuality += 6;
  else if (rr >= 1.5) executionQuality += 5;
  if (confidence >= 85) executionQuality += 4;
  else if (confidence >= 80) executionQuality += 3;
  else if (confidence >= 75) executionQuality += 2;
  if (targetConfidence) {
    const timing = finite(targetConfidence?.timingScore, 0);
    const geometry = finite(targetConfidence?.geometryScore, 0);
    executionQuality += Math.round((Math.min(100, timing) / 100) * 2);
    executionQuality += Math.round((Math.min(100, geometry) / 100) * 2);
  } else if (analysis?.targetAdjustedToMinRR !== true) {
    executionQuality += 4;
  }
  executionQuality = clamp(executionQuality, 0, 15);

  let learningQuality = 6;
  const learningAdjustment = finite(analysis?.combinedLearningContext?.combinedAdjustment, 0);
  if (learningAdjustment > 0) learningQuality += Math.min(4, Math.round(learningAdjustment));
  else if (learningAdjustment < 0) learningQuality -= Math.min(4, Math.ceil(Math.abs(learningAdjustment)));
  learningQuality = clamp(learningQuality, 0, 10);

  if (targetConfidence) {
    const drift = finite(targetConfidence?.entryDriftAtr, 99);
    const consumed = finite(targetConfidence?.rewardConsumedFraction, 1);
    const timing = finite(targetConfidence?.timingScore, 0);
    if (drift > config.maximumEntryDriftAtr) blockers.push(`entry drift ${drift.toFixed(2)} ATR exceeds ${config.maximumEntryDriftAtr.toFixed(2)}`);
    if (consumed > config.maximumRewardConsumedFraction) blockers.push(`reward consumed ${Math.round(consumed * 100)}% exceeds ${Math.round(config.maximumRewardConsumedFraction * 100)}%`);
    if (targetConfidence?.priceInsideEntryZone === false) blockers.push('executable price is outside the planned entry zone');
    if (timing < config.minimumTimingScore) blockers.push(`timing score ${Math.round(timing)} is below ${config.minimumTimingScore}`);
  }
  if (exhaustion.score > config.maximumExhaustionRisk) {
    blockers.push(`exhaustion risk ${exhaustion.score} exceeds ${config.maximumExhaustionRisk}`);
  }

  const score = clamp(Math.round(structuralQuality + freshnessQuality + liquidityQuality + executionQuality + learningQuality));
  if (score < config.minimumScore) blockers.push(`A-grade score ${score} is below ${config.minimumScore}`);

  const uniqueBlockers = [...new Set(blockers)];
  const passed = uniqueBlockers.length === 0;
  return {
    schemaVersion: 1,
    stage,
    grade: passed ? 'A' : score >= 70 ? 'B' : 'C',
    score,
    threshold: config.minimumScore,
    passed,
    required: config.required,
    family,
    exhaustionRiskScore: exhaustion.score,
    exhaustionReasons: exhaustion.reasons,
    components: {
      structuralQuality,
      freshnessQuality,
      liquidityQuality,
      executionQuality,
      learningQuality,
    },
    executionMetrics: targetConfidence ? {
      timingScore: finite(targetConfidence?.timingScore),
      geometryScore: finite(targetConfidence?.geometryScore),
      entryDriftAtr: finite(targetConfidence?.entryDriftAtr),
      rewardConsumedFraction: finite(targetConfidence?.rewardConsumedFraction),
      priceInsideEntryZone: targetConfidence?.priceInsideEntryZone === true,
      actualRR: finite(targetConfidence?.actualRR),
    } : null,
    blockers: uniqueBlockers,
  };
}

export function withIctAGradeEvaluation(analysis = {}, options = {}) {
  const aGrade = evaluateIctAGradeSetup(analysis, options);
  return { ...analysis, aGrade };
}

let supabaseClient = null;
function database(env = process.env) {
  if (supabaseClient) return supabaseClient;
  const url = clean(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || env.VITE_SUPABASE_URL);
  const key = clean(env.SUPABASE_SERVICE_ROLE_KEY);
  if (!url || !key) return null;
  supabaseClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return supabaseClient;
}

function compactAnalysisSnapshot(analysis = {}) {
  return {
    signalId: analysis?.signalId ?? null,
    confidence: finite(analysis?.confidence),
    rr: finite(analysis?.rr),
    entryAuthorization: analysis?.entryAuthorization ?? null,
    correctiveGate: analysis?.correctiveGate ?? null,
    timeframeBias: analysis?.timeframeBias ?? null,
    h1Momentum: analysis?.h1Momentum ?? null,
    h1Transition: analysis?.h1Transition ?? null,
    continuationBreakout: analysis?.continuationBreakout ?? null,
    marketMakerModel: analysis?.marketMakerModel ? {
      studyReady: analysis.marketMakerModel.studyReady === true,
      stage: analysis.marketMakerModel.stage ?? null,
      keyLevelTap: analysis.marketMakerModel.keyLevelTap ?? null,
      observation: analysis.marketMakerModel.observation ?? null,
    } : null,
    targetConfidence: analysis?.targetConfidence ?? null,
  };
}

export async function recordIctAGradeDecision({
  client,
  analysis,
  evaluation = analysis?.aGrade,
  stage = evaluation?.stage || 'scanner',
  executionTelemetry = null,
  executed = false,
  brokerTradeId = null,
  now = new Date(),
} = {}) {
  const db = database();
  if (!db || !client?.userId || !analysis?.pair || !evaluation) return null;
  const broker = client?.executionProvider === 'ftmo_mt5_ea' ? 'ftmo' : 'oanda';
  const brokerAccountId = clean(client?.executionAccountId || client?.accountId) || null;
  const direction = analysis?.signal === 'buy' ? 'long' : analysis?.signal === 'sell' ? 'short' : clean(analysis?.direction).toLowerCase();
  const signalId = clean(analysis?.signalId || analysis?.ictSignalId) || null;
  if (!signalId) return null;

  const payload = {
    user_id: clean(client.userId),
    broker,
    broker_account_id: brokerAccountId,
    environment: clean(client?.executionEnvironment || client?.environment) || null,
    pair: clean(analysis.pair).toUpperCase(),
    direction: direction || null,
    signal_id: signalId,
    decision_stage: clean(stage) || 'scanner',
    observed_at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    grade: evaluation.grade,
    score: evaluation.score,
    threshold: evaluation.threshold,
    passed: evaluation.passed === true,
    exhaustion_risk_score: evaluation.exhaustionRiskScore,
    components: evaluation.components || {},
    blockers: evaluation.blockers || [],
    analysis_snapshot: compactAnalysisSnapshot(analysis),
    execution_telemetry: executionTelemetry,
    executed: executed === true,
    broker_trade_id: brokerTradeId == null ? null : String(brokerTradeId),
  };

  const { data, error } = await db.from('ict_a_grade_decisions')
    .upsert(payload, { onConflict: 'user_id,broker_account_id,signal_id,decision_stage' })
    .select('id')
    .maybeSingle();
  if (error) {
    console.warn(`[ICT_A_GRADE] audit write skipped: ${error.message}`);
    return null;
  }
  return data?.id ? String(data.id) : null;
}
