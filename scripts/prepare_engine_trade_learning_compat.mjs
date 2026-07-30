import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function rewrite(relativePath, transform, root = ROOT) {
  const path = resolve(root, relativePath);
  const before = readFileSync(path, 'utf8');
  const after = transform(before);
  if (after !== before) writeFileSync(path, after, 'utf8');
  console.log(`[ENGINE_LEARNING_COMPAT] verified ${relativePath}${after !== before ? ' (normalized)' : ''}`);
  return after !== before;
}

function restoreMarketStudyAuto(source, engine) {
  return source
    .replace(
      "import { runDailyMarketStudy } from './dailyMarketStudy.js';\nimport { applyCombinedLearningCalibration } from './engineTradeLearning.js';",
      "import { applyStoredStudyCalibration, runDailyMarketStudy } from './dailyMarketStudy.js';",
    )
    .replaceAll(
      `applyCombinedLearningCalibration(item, { client, engine: '${engine}' })`,
      `applyStoredStudyCalibration(item, { client, engine: '${engine}' })`,
    );
}

function restoreIctExecution(source) {
  return source
    .replace(
      "import { applyCombinedLearningCalibration } from './engineTradeLearning.js';",
      "import { applyStoredStudyCalibration } from './dailyMarketStudy.js';",
    )
    .replaceAll('applyCombinedLearningCalibration(', 'applyStoredStudyCalibration(');
}

function restorePprExecution(source) {
  return source
    .replace(
      "import { applyCombinedLearningCalibration } from './engineTradeLearning.js';",
      "import { applyStoredStudyCalibration } from './dailyMarketStudy.js';",
    )
    .replaceAll('applyCombinedLearningCalibration(', 'applyStoredStudyCalibration(')
    .replaceAll('calibratedSignal', 'studiedSignal')
    .replaceAll('combined market/engine calibration', 'daily-study calibration');
}

/**
 * Existing generated-source policy scripts predate engine learning and validate
 * the market-study symbol names. Normalize only those symbols before the legacy
 * policy pass; apply_engine_trade_learning.mjs restores the combined layer last.
 */
export function prepareEngineTradeLearningCompatibility(root = ROOT) {
  const changed = [];
  if (rewrite('server/ictAutoTrade.js', (source) => restoreMarketStudyAuto(source, 'ict'), root)) changed.push('server/ictAutoTrade.js');
  if (rewrite('server/ictExecution.js', restoreIctExecution, root)) changed.push('server/ictExecution.js');
  if (rewrite('server/pprAutoTrade.js', (source) => restoreMarketStudyAuto(source, 'ppr'), root)) changed.push('server/pprAutoTrade.js');
  if (rewrite('server/pprExecution.js', restorePprExecution, root)) changed.push('server/pprExecution.js');
  return changed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareEngineTradeLearningCompatibility();
}
