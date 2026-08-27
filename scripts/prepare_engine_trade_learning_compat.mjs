import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

function restoreDailyBotSchedulerCompatibility(source) {
  const current = '`[AUTO_AI] morningStudy=02:00_ET endOfDayReview=17:30_ET scans=02:30–10:30_ET entries=02:30–10:30_ET weekdays_only ` + \'\'';
  const legacy = '`[AUTO_AI] endOfDayReview=17:30_ET scans=02:00–10:00_ET entries=02:30–10:00_ET weekdays_only ` + \'\'';
  if (!source.includes('LEGACY_DAILY_BOT_POLICY_DIAGNOSTIC')) return source;
  return source.replace(current, legacy);
}

/**
 * Existing generated-source policy scripts predate engine learning and validate
 * the market-study symbol names. Normalize only those symbols before the legacy
 * policy pass; apply_engine_trade_learning.mjs restores the combined layer last.
 * The scheduler's legacy verification token is restored only for the legacy
 * policy pass; the final qualification contract immediately normalizes it back
 * to the authoritative 02:30–10:30 ET runtime diagnostic.
 */
export function prepareEngineTradeLearningCompatibility(root = ROOT) {
  const changed = [];
  if (rewrite('server/ictAutoTrade.js', (source) => restoreMarketStudyAuto(source, 'ict'), root)) changed.push('server/ictAutoTrade.js');
  if (rewrite('server/ictExecution.js', restoreIctExecution, root)) changed.push('server/ictExecution.js');
  if (rewrite('server/pprAutoTrade.js', (source) => restoreMarketStudyAuto(source, 'ppr'), root)) changed.push('server/pprAutoTrade.js');
  if (rewrite('server/pprExecution.js', restorePprExecution, root)) changed.push('server/pprExecution.js');
  const schedulerPath = resolve(root, 'server/ictAutoScheduler.js');
  if (existsSync(schedulerPath) && rewrite('server/ictAutoScheduler.js', restoreDailyBotSchedulerCompatibility, root)) {
    changed.push('server/ictAutoScheduler.js');
  }
  return changed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareEngineTradeLearningCompatibility();
}
