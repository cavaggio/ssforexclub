import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function replaceRequired(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`[ENGINE_LEARNING_PATCH] missing ${label}`);
  return source.replace(before, after);
}

function patchIct(source) {
  let out = source;
  out = replaceRequired(
    out,
    "import { applyStoredStudyCalibration, runDailyMarketStudy } from './dailyMarketStudy.js';",
    "import { runDailyMarketStudy } from './dailyMarketStudy.js';\nimport { applyCombinedLearningCalibration } from './engineTradeLearning.js';",
    'ICT learning import',
  );
  out = out.replaceAll(
    "applyStoredStudyCalibration(item, { client, engine: 'ict' })",
    "applyCombinedLearningCalibration(item, { client, engine: 'ict' })",
  );
  out = replaceRequired(
    out,
    "executed.push({ pair: a.pair, direction, tradeId: res.tradeId, units: res.units, holdMinutes: res.holdMinutes });",
    `executed.push({
        pair: a.pair,
        direction,
        tradeId: res.tradeId,
        fillPrice: res.fillPrice ?? a.entry,
        units: res.units,
        stopLoss: res.stopLoss ?? a.stopLoss,
        takeProfit: res.takeProfit ?? a.target1,
        confidence: a.confidence,
        expectedRR: a.rr,
        holdMinutes: res.holdMinutes,
        strategy: 'ICT',
        signal: a,
      });`,
    'ICT executed observation attribution',
  );
  out = replaceRequired(
    out,
    "return { scanned: analyses.length, qualified: 0, executed: [], skipped: [], ...watchState };",
    "return { scanned: analyses.length, qualified: 0, executed: [], skipped: [], results: analyses, ...watchState };",
    'ICT empty-scan learning evidence',
  );
  out = replaceRequired(
    out,
    "return { scanned: analyses.length, qualified: qualified.length, executed, skipped, ...watchState };",
    "return { scanned: analyses.length, qualified: qualified.length, executed, skipped, results: analyses, ...watchState };",
    'ICT completed-scan learning evidence',
  );
  if (!out.includes('applyCombinedLearningCalibration') || (!out.includes('combinedLearningContext') && !out.includes('results: analyses'))) {
    throw new Error('[ENGINE_LEARNING_PATCH] ICT markers incomplete');
  }
  return out;
}

function patchPpr(source) {
  let out = source;
  out = replaceRequired(
    out,
    "import { applyStoredStudyCalibration, runDailyMarketStudy } from './dailyMarketStudy.js';",
    "import { runDailyMarketStudy } from './dailyMarketStudy.js';\nimport { applyCombinedLearningCalibration } from './engineTradeLearning.js';",
    'PPR learning import',
  );
  out = out.replaceAll(
    "applyStoredStudyCalibration(item, { client, engine: 'ppr' })",
    "applyCombinedLearningCalibration(item, { client, engine: 'ppr' })",
  );
  if (!out.includes('qualifiedCandidates: qualified,')) {
    out = out.replaceAll(
      '      watchCandidates: scan?.watchCandidates || [],',
      '      qualifiedCandidates: qualified,\n      watchCandidates: scan?.watchCandidates || [],',
    );
    out = out.replaceAll(
      '    watchCandidates: scan?.watchCandidates || [],',
      '    qualifiedCandidates: qualified,\n    watchCandidates: scan?.watchCandidates || [],',
    );
  }
  if (!out.includes('applyCombinedLearningCalibration') || !out.includes('qualifiedCandidates: qualified')) {
    throw new Error('[ENGINE_LEARNING_PATCH] PPR markers incomplete');
  }
  return out;
}

function patchV3(source) {
  let out = source;
  out = replaceRequired(
    out,
    "import { applyScalpMetadata } from './scalpOnlyPolicy.js';",
    "import { applyScalpMetadata } from './scalpOnlyPolicy.js';\nimport { applyCombinedLearningCalibration } from './engineTradeLearning.js';",
    'V3 learning import',
  );
  out = replaceRequired(
    out,
    `  const qualified = (Array.isArray(scan?.qualified) ? scan.qualified : []).map((signal) =>
    applyScalpMetadata({
      ...signal,
      source: 'v3_pure_auto_ai',
      strategy: 'V3',
      engine: 'v3',
      tradeStyle: 'SCALP',
      scalpOnly: true,
      selectedLogicType: 'v3_pure',
      architecture: 'independent_v3_raw_market_data',
    }),
  );`,
    `  const qualified = await Promise.all(
    (Array.isArray(scan?.qualified) ? scan.qualified : []).map(async (signal) => {
      const calibrated = await applyCombinedLearningCalibration(signal, { client, engine: 'v3' });
      return applyScalpMetadata({
        ...calibrated,
        source: 'v3_pure_auto_ai',
        strategy: 'V3',
        engine: 'v3',
        tradeStyle: 'SCALP',
        scalpOnly: true,
        selectedLogicType: 'v3_pure',
        architecture: 'independent_v3_raw_market_data',
      });
    }),
  );`,
    'V3 qualified calibration block',
  );
  if (!out.includes('qualifiedCandidates: qualified,')) {
    out = out.replaceAll(
      '      watchCandidates: stageWatchCandidates,',
      '      qualifiedCandidates: qualified,\n      watchCandidates: stageWatchCandidates,\n      rejected: scan?.rejected || [],',
    );
    out = out.replaceAll(
      '    watchCandidates: stageWatchCandidates,',
      '    qualifiedCandidates: qualified,\n    watchCandidates: stageWatchCandidates,\n    rejected: scan?.rejected || [],',
    );
  }
  if (!out.includes('applyCombinedLearningCalibration') || !out.includes('qualifiedCandidates: qualified')) {
    throw new Error('[ENGINE_LEARNING_PATCH] V3 markers incomplete');
  }
  return out;
}

const PATCHES = [
  ['server/ictAutoTrade.js', patchIct],
  ['server/pprAutoTrade.js', patchPpr],
  ['server/v3AutoTrade.js', patchV3],
];

export function applyEngineTradeLearningPatch(root = ROOT) {
  const changed = [];
  for (const [relativePath, patcher] of PATCHES) {
    const path = resolve(root, relativePath);
    const before = readFileSync(path, 'utf8');
    const after = patcher(before);
    if (after !== before) {
      writeFileSync(path, after, 'utf8');
      changed.push(relativePath);
    }
    console.log(`[ENGINE_LEARNING_PATCH] verified ${relativePath}${after !== before ? ' (patched)' : ''}`);
  }
  return changed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  applyEngineTradeLearningPatch();
}
