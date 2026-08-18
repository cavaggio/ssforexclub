import { createClient } from '@supabase/supabase-js';
import { applyStoredStudyCalibration } from './dailyMarketStudy.js';
import {
  ENGINE_TRADE_LEARNING_HARD_GATES,
  applyBoundedConfidence,
  computeEngineTradeAdjustment,
} from './engineTradeLearningCore.js';
import {
  assessCandidateExecutionQuality,
  separateSignalAndExecutionLearning,
} from './signalExecutionQuality.js';

const profileCache = new Map();
let supabaseClient;
let warnedMissingSchema = false;

function db() {
  if (supabaseClient !== undefined) return supabaseClient;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  supabaseClient = url && key
    ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;
  return supabaseClient;
}

function finiteNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeEngine(value) {
  const engine = String(value || '').trim().toLowerCase();
  return ['ict', 'ppr', 'v3'].includes(engine) ? engine : null;
}

function normalizePair(value) {
  const pair = String(value || '').trim().replace('/', '_').toUpperCase();
  return /^[A-Z]{3}_[A-Z]{3}$/.test(pair) ? pair : null;
}

function accountIdOf(client) {
  return String(client?.accountId || client?.accountID || client?.account_id || 'default');
}

function userIdOf(client) {
  const value = String(client?.userId || client?.user_id || '').trim();
  return value || null;
}

function cacheTtlMs() {
  const configured = finiteNumber(process.env.ENGINE_TRADE_LEARNING_CACHE_MS, 300_000);
  return Math.max(30_000, Math.min(3_600_000, configured));
}

function learningMode() {
  const configured = String(process.env.ENGINE_TRADE_LEARNING_MODE || 'limited').trim().toLowerCase();
  return ['off', 'shadow', 'limited', 'active'].includes(configured) ? configured : 'limited';
}

function optionsFromEnv() {
  return {
    mode: learningMode(),
    displayMinimum: Math.max(5, finiteNumber(process.env.ENGINE_TRADE_LEARNING_DISPLAY_MIN, 10)),
    liveMinimum: Math.max(20, finiteNumber(process.env.ENGINE_TRADE_LEARNING_LIVE_MIN, 30)),
    fullWeightMinimum: Math.max(50, finiteNumber(process.env.ENGINE_TRADE_LEARNING_FULL_WEIGHT_MIN, 100)),
    segmentMinimum: Math.max(5, finiteNumber(process.env.ENGINE_TRADE_LEARNING_SEGMENT_MIN, 12)),
    confirmationMinimum: Math.max(5, finiteNumber(process.env.ENGINE_TRADE_LEARNING_CONFIRMATION_MIN, 15)),
    maxAdjustment: Math.min(3, Math.max(0, finiteNumber(process.env.ENGINE_TRADE_LEARNING_MAX_ADJUSTMENT, 3))),
  };
}

function schemaMissing(error) {
  const message = String(error?.message || error || '');
  const code = String(error?.code || '');
  return ['42P01', '42703', 'PGRST205', 'PGRST204'].includes(code) ||
    /engine_executed_|engine_combined_pair_stats|engine_actual_account_accuracy_7d|engine_actual_account_pair_accuracy_7d|engine_learning_adjustment_audit/i.test(message) ||
    /engine_signal_learning_stats|engine_learning_adjustment_effectiveness_stats|ict_trade_failure_stats/i.test(message);
}

async function loadRows(view, userId, accountId, engine, pair) {
  const supabase = db();
  if (!supabase) return [];
  let query = supabase
    .from(view)
    .select('*')
    .eq('broker_account_id', accountId)
    .eq('engine', engine)
    .eq('pair', pair)
    .eq('horizon_minutes', 60);
  if (userId) query = query.eq('user_id', userId);
  const { data, error } = await query;
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function loadAccountRows(view, userId, accountId, engine) {
  const supabase = db();
  if (!supabase) return [];
  let query = supabase
    .from(view)
    .select('*')
    .eq('broker_account_id', accountId)
    .eq('engine', engine);
  if (userId) query = query.eq('user_id', userId);
  const { data, error } = await query;
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function loadEngineTradeProfile({ client, engine, pair, force = false } = {}) {
  const normalizedEngine = normalizeEngine(engine);
  const normalizedPair = normalizePair(pair);
  const accountId = accountIdOf(client);
  const userId = userIdOf(client);
  if (!normalizedEngine || !normalizedPair || !db()) return null;
  const key = `${userId || 'legacy'}:${accountId}:${normalizedEngine}:${normalizedPair}`;
  const cached = profileCache.get(key);
  if (!force && cached && Date.now() - cached.loadedAt < cacheTtlMs()) return cached.profile;

  try {
    const [pairRows, recentPairRows, accountRows7d, contextStats, confirmationStats, qualityRows] = await Promise.all([
      loadRows('engine_combined_pair_stats', userId, accountId, normalizedEngine, normalizedPair),
      loadRows('engine_actual_account_pair_accuracy_7d', userId, accountId, normalizedEngine, normalizedPair),
      loadAccountRows('engine_actual_account_accuracy_7d', userId, accountId, normalizedEngine),
      loadRows('engine_executed_context_stats', userId, accountId, normalizedEngine, normalizedPair),
      loadRows('engine_executed_confirmation_stats', userId, accountId, normalizedEngine, normalizedPair),
      loadRows('engine_execution_quality_stats', userId, accountId, normalizedEngine, normalizedPair),
    ]);
    const [signalQualityRows, adjustmentEffectivenessRows, failureRows] = await Promise.all([
      loadRows('engine_signal_learning_stats', userId, accountId, normalizedEngine, normalizedPair),
      loadRows('engine_learning_adjustment_effectiveness_stats', userId, accountId, normalizedEngine, normalizedPair),
      loadRows('ict_trade_failure_stats', userId, accountId, normalizedEngine, normalizedPair),
    ]);
    const profile = {
      accountId,
      userId,
      engine: normalizedEngine,
      pair: normalizedPair,
      pairSummary: pairRows[0] || null,
      recentPairSummary7d: recentPairRows[0] || null,
      accountSummary7d: accountRows7d[0] || null,
      contextStats,
      confirmationStats,
      executionQuality: qualityRows[0] || null,
      signalQuality: signalQualityRows[0] || null,
      adjustmentEffectiveness: adjustmentEffectivenessRows[0] || null,
      failureStats: failureRows[0] || null,
      loadedAt: new Date().toISOString(),
    };
    profileCache.set(key, { loadedAt: Date.now(), profile });
    return profile;
  } catch (error) {
    if (schemaMissing(error)) {
      if (!warnedMissingSchema) {
        warnedMissingSchema = true;
        console.warn('[ENGINE_LEARNING] migrations 20260730110000, 20260730162000 and 20260815120000 are required; market study remains active');
      }
      return null;
    }
    console.warn(`[ENGINE_LEARNING] profile read failed ${normalizedEngine}/${normalizedPair}: ${error?.message || String(error)}`);
    return null;
  }
}

function compactCandidate(candidate = {}) {
  return {
    pair: candidate.pair || candidate.instrument || candidate.symbol || null,
    direction: candidate.direction || candidate.side || candidate.signal || null,
    session: candidate.session?.name || candidate.session || null,
    confidence: finiteNumber(candidate.confidence ?? candidate.score),
    rr: finiteNumber(candidate.expectedRR ?? candidate.rr ?? candidate.riskReward),
    spreadPips: finiteNumber(candidate.spreadPips ?? candidate.spread),
    marketRegime: candidate.marketRegime?.regime || candidate.marketRegime || null,
    volatility: candidate.volatilityState || candidate.volatility || null,
    dailyDirection: candidate.dailyDirection || candidate.dailyStudyContext?.dayDirection || null,
    h4Direction: candidate.h4Direction || null,
    executionQuality: assessCandidateExecutionQuality(candidate),
  };
}

async function persistAudit({ client, engine, pair, candidate, confidence, engineResult, qualitySeparation }) {
  const supabase = db();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('engine_learning_adjustment_audit')
      .insert({
        user_id: userIdOf(client),
        broker_account_id: accountIdOf(client),
        environment: String(client?.environment || 'unknown'),
        engine,
        pair,
        direction: String(candidate?.direction || candidate?.side || candidate?.signal || '') || null,
        mode: engineResult.mode,
        recommendation_stage: engineResult.stage,
        sample_size: engineResult.sampleSize,
        original_confidence: confidence.originalConfidence,
        market_study_adjustment: confidence.marketStudyAdjustment,
        engine_trade_adjustment: confidence.engineTradeAdjustment,
        combined_adjustment: confidence.combinedAdjustment,
        final_confidence: confidence.finalConfidence,
        component_adjustments: [
          ...(Array.isArray(engineResult.components) ? engineResult.components : []),
          {
            name: 'current_entry_execution_quality',
            qualityDimension: 'execution',
            adjustment: qualitySeparation?.executionQuality?.currentCandidateAdjustment ?? 0,
            reasons: qualitySeparation?.executionQuality?.currentCandidate?.reasons ?? [],
            advisoryOnly: true,
          },
        ],
        reasons: [
          ...(Array.isArray(engineResult.reasons) ? engineResult.reasons : []),
          ...(qualitySeparation?.executionQuality?.currentCandidate?.reasons ?? []).map((item) => item.reason),
        ],
        hard_gates_preserved: ENGINE_TRADE_LEARNING_HARD_GATES,
        adjustment_type: 'pre_trade_calibration',
        applied: true,
        applied_at: new Date().toISOString(),
        failure_reasons: [],
        candidate_snapshot: {
          ...compactCandidate(candidate),
          qualitySeparation,
        },
      })
      .select('id')
      .maybeSingle();
    if (error && !schemaMissing(error)) throw error;
    return data?.id ? String(data.id) : null;
  } catch (error) {
    if (!schemaMissing(error)) {
      console.warn(`[ENGINE_LEARNING] audit write failed ${engine}/${pair}: ${error?.message || String(error)}`);
    }
    return null;
  }
}

/**
 * Applies the existing Daily/4H market study first, then applies an independent
 * engine-specific adjustment learned from actual broker outcomes, broad signal
 * outcomes, and exact applied-adjustment audits. The combined adjustment is
 * capped at +/-5 confidence points and does not alter any hard execution gate.
 */
export async function applyCombinedLearningCalibration(candidate = {}, { client, engine } = {}) {
  const normalizedEngine = normalizeEngine(engine || candidate.engine || candidate.strategy);
  const pair = normalizePair(candidate.pair || candidate.instrument || candidate.symbol);
  if (!normalizedEngine || !pair) return candidate;

  const originalConfidence = finiteNumber(candidate.confidence ?? candidate.score, null);
  const studiedCandidate = await applyStoredStudyCalibration(candidate, { client, engine: normalizedEngine });
  const marketStudyAdjustment = finiteNumber(studiedCandidate?.dailyStudyContext?.adjustment, 0);
  const profile = await loadEngineTradeProfile({ client, engine: normalizedEngine, pair });
  const learningOptions = optionsFromEnv();
  const engineResult = computeEngineTradeAdjustment(
    { ...studiedCandidate, engine: normalizedEngine, pair },
    profile || { engine: normalizedEngine, pair, pairSummary: { outcomes: 0 } },
    learningOptions,
  );
  const qualitySeparation = separateSignalAndExecutionLearning({
    engineResult,
    candidate: { ...studiedCandidate, engine: normalizedEngine, pair },
    options: learningOptions,
  });
  const confidence = applyBoundedConfidence({
    originalConfidence,
    marketStudyAdjustment,
    engineTradeAdjustment: qualitySeparation.signalQuality.appliedAdjustment,
    maxCombinedAdjustment: 5,
  });
  const executionConfidence = applyBoundedConfidence({
    originalConfidence: confidence.finalConfidence,
    marketStudyAdjustment: 0,
    engineTradeAdjustment: qualitySeparation.executionQuality.appliedAdjustment,
    maxCombinedAdjustment: 3,
  });

  const auditId = await persistAudit({
    client,
    engine: normalizedEngine,
    pair,
    candidate: studiedCandidate,
    confidence,
    engineResult,
    qualitySeparation,
  });

  const learningContext = {
    auditId,
    engine: normalizedEngine,
    pair,
    mode: engineResult.mode,
    stage: engineResult.stage,
    sampleSize: engineResult.sampleSize,
    marketStudyAdjustment: confidence.marketStudyAdjustment,
    engineTradeAdjustment: confidence.engineTradeAdjustment,
    rawEngineTradeAdjustment: engineResult.rawAdjustment,
    signalQualityAdjustment: qualitySeparation.signalQuality.appliedAdjustment,
    executionQualityAdjustment: qualitySeparation.executionQuality.appliedAdjustment,
    signalQualityConfidence: confidence.finalConfidence,
    executionQualityConfidence: executionConfidence.finalConfidence,
    qualitySeparation,
    combinedAdjustment: confidence.combinedAdjustment,
    originalConfidence: confidence.originalConfidence,
    finalConfidence: confidence.finalConfidence,
    components: engineResult.components,
    reasons: engineResult.reasons,
    hardGatesPreserved: ENGINE_TRADE_LEARNING_HARD_GATES,
    scope: 'broker_account_engine_pair',
  };

  const calibrated = {
    ...studiedCandidate,
    baseConfidence: originalConfidence,
    adjustedConfidence: confidence.finalConfidence,
    signalQualityConfidence: confidence.finalConfidence,
    executionQualityConfidence: executionConfidence.finalConfidence,
    entryQualityAdjustment: qualitySeparation.executionQuality.appliedAdjustment,
    executionQuality: qualitySeparation.executionQuality.currentCandidate,
    combinedLearningContext: learningContext,
  };
  if (confidence.finalConfidence != null) {
    calibrated.confidence = confidence.finalConfidence;
    if (finiteNumber(studiedCandidate.tpHitConfidence, null) != null) {
      calibrated.tpHitConfidence = confidence.finalConfidence;
    }
    calibrated.entryQualityConfidence = executionConfidence.finalConfidence;
  }

  return calibrated;
}

export function __resetEngineTradeLearningForTests() {
  profileCache.clear();
  supabaseClient = undefined;
  warnedMissingSchema = false;
}
