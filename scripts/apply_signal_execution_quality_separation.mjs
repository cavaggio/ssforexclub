import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function replaceRequired(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`[QUALITY_SEPARATION] missing ${label}`);
  return source.replace(before, after);
}

function patchTargetConfidence(source) {
  let out = source;
  out = replaceRequired(
    out,
    `  const weighted = (confluence * 0.75) + (geometryScore * 0.25);
  const confidence = Math.round(clamp(Math.min(weighted, geometryScore, confluence)));`,
    `  const signalQualityConfidence = Math.round(confluence);
  const executionQualityConfidence = Math.round(clamp((timingScore * 0.65) + (geometryScore * 0.35)));
  // Timing/fill inefficiency reduces target-hit confidence by at most three points.
  // It remains a bounded confidence adjustment, not a new hard rejection rule.
  const executionQualityAdjustment = -Math.min(
    3,
    Math.max(0, Math.round((100 - executionQualityConfidence) / 15)),
  );
  const weighted = (confluence * 0.75) + (geometryScore * 0.25);
  const baseConfidence = Math.round(clamp(Math.min(weighted, geometryScore, confluence)));
  const confidence = Math.round(clamp(baseConfidence + executionQualityAdjustment));`,
    'ICT separated confidence calculation',
  );
  out = replaceRequired(
    out,
    `    confluenceScore: Math.round(confluence),
    timingScore: Math.round(timingScore),
    geometryScore: Math.round(geometryScore),`,
    `    confluenceScore: Math.round(confluence),
    signalQualityConfidence,
    executionQualityConfidence,
    executionQualityAdjustment,
    baseConfidence,
    timingScore: Math.round(timingScore),
    geometryScore: Math.round(geometryScore),`,
    'ICT separated confidence response',
  );
  out = out.replace("model: 'ict_current_executable_scalp_v2'", "model: 'ict_signal_execution_quality_v3'");
  const required = [
    'signalQualityConfidence',
    'executionQualityConfidence',
    'executionQualityAdjustment',
    "model: 'ict_signal_execution_quality_v3'",
  ];
  const missing = required.filter((marker) => !out.includes(marker));
  if (missing.length) throw new Error(`[QUALITY_SEPARATION] target confidence markers missing: ${missing.join(', ')}`);
  return out;
}

function patchEngineLearning(source) {
  let out = source;
  out = replaceRequired(
    out,
    `} from './engineTradeLearningCore.js';`,
    `} from './engineTradeLearningCore.js';
import {
  assessCandidateExecutionQuality,
  separateSignalAndExecutionLearning,
} from './signalExecutionQuality.js';`,
    'quality separation import',
  );
  out = replaceRequired(
    out,
    `    h4Direction: candidate.h4Direction || null,
  };`,
    `    h4Direction: candidate.h4Direction || null,
    executionQuality: assessCandidateExecutionQuality(candidate),
  };`,
    'execution quality audit snapshot',
  );
  out = replaceRequired(
    out,
    `async function persistAudit({ client, engine, pair, candidate, confidence, engineResult }) {`,
    `async function persistAudit({ client, engine, pair, candidate, confidence, engineResult, qualitySeparation }) {`,
    'audit quality separation argument',
  );
  out = replaceRequired(
    out,
    `      component_adjustments: engineResult.components,
      reasons: engineResult.reasons,
      hard_gates_preserved: ENGINE_TRADE_LEARNING_HARD_GATES,
      candidate_snapshot: compactCandidate(candidate),`,
    `      component_adjustments: [
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
      candidate_snapshot: {
        ...compactCandidate(candidate),
        qualitySeparation,
      },`,
    'separated audit payload',
  );
  out = replaceRequired(
    out,
    `  const engineResult = computeEngineTradeAdjustment(
    { ...studiedCandidate, engine: normalizedEngine, pair },
    profile || { engine: normalizedEngine, pair, pairSummary: { outcomes: 0 } },
    optionsFromEnv(),
  );
  const confidence = applyBoundedConfidence({
    originalConfidence,
    marketStudyAdjustment,
    engineTradeAdjustment: engineResult.appliedAdjustment,
    maxCombinedAdjustment: 5,
  });`,
    `  const learningOptions = optionsFromEnv();
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
  });`,
    'separated learning confidence block',
  );
  out = replaceRequired(
    out,
    `    engineTradeAdjustment: confidence.engineTradeAdjustment,
    rawEngineTradeAdjustment: engineResult.rawAdjustment,
    combinedAdjustment: confidence.combinedAdjustment,`,
    `    engineTradeAdjustment: confidence.engineTradeAdjustment,
    rawEngineTradeAdjustment: engineResult.rawAdjustment,
    signalQualityAdjustment: qualitySeparation.signalQuality.appliedAdjustment,
    executionQualityAdjustment: qualitySeparation.executionQuality.appliedAdjustment,
    signalQualityConfidence: confidence.finalConfidence,
    executionQualityConfidence: executionConfidence.finalConfidence,
    qualitySeparation,
    combinedAdjustment: confidence.combinedAdjustment,`,
    'separated learning context',
  );
  out = replaceRequired(
    out,
    `    baseConfidence: originalConfidence,
    adjustedConfidence: confidence.finalConfidence,
    combinedLearningContext: learningContext,`,
    `    baseConfidence: originalConfidence,
    adjustedConfidence: confidence.finalConfidence,
    signalQualityConfidence: confidence.finalConfidence,
    executionQualityConfidence: executionConfidence.finalConfidence,
    entryQualityAdjustment: qualitySeparation.executionQuality.appliedAdjustment,
    executionQuality: qualitySeparation.executionQuality.currentCandidate,
    combinedLearningContext: learningContext,`,
    'separated calibrated candidate',
  );
  out = replaceRequired(
    out,
    `    if (finiteNumber(studiedCandidate.entryQualityConfidence, null) != null) {
      calibrated.entryQualityConfidence = confidence.finalConfidence;
    }`,
    `    calibrated.entryQualityConfidence = executionConfidence.finalConfidence;`,
    'entry quality confidence separation',
  );
  out = replaceRequired(
    out,
    `    engineResult,
  });`,
    `    engineResult,
    qualitySeparation,
  });`,
    'separated audit call',
  );
  const required = [
    'separateSignalAndExecutionLearning',
    'signalQualityConfidence',
    'executionQualityConfidence',
    'entryQualityAdjustment',
    'qualitySeparation,',
  ];
  const missing = required.filter((marker) => !out.includes(marker));
  if (missing.length) throw new Error(`[QUALITY_SEPARATION] engine learning markers missing: ${missing.join(', ')}`);
  return out;
}

export function applySignalExecutionQualitySeparation(root = ROOT) {
  const paths = [
    ['server/ictTargetConfidence.js', patchTargetConfidence],
    ['server/engineTradeLearning.js', patchEngineLearning],
  ];
  const changed = [];
  for (const [relativePath, patcher] of paths) {
    const path = resolve(root, relativePath);
    const before = readFileSync(path, 'utf8');
    const after = patcher(before);
    if (after !== before) {
      writeFileSync(path, after, 'utf8');
      changed.push(relativePath);
    }
    console.log(`[QUALITY_SEPARATION] verified ${relativePath}${after !== before ? ' (patched)' : ''}`);
  }
  return changed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  applySignalExecutionQualitySeparation();
}
