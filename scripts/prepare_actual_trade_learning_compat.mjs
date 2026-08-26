import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function prepareActualTradeLearningCompatibility(root = DEFAULT_ROOT) {
  const learningPath = resolve(root, 'server/engineTradeLearning.js');
  const learningBefore = readFileSync(learningPath, 'utf8');
  const learningAfter = learningBefore
    .replaceAll("loadRows('engine_combined_pair_stats'", "loadRows('engine_executed_pair_stats'")
    .replaceAll("loadRows('engine_actual_account_pair_accuracy_7d'", "loadRows('engine_account_pair_accuracy_7d'")
    .replaceAll("loadAccountRows('engine_actual_account_accuracy_7d'", "loadAccountRows('engine_account_accuracy_7d'");
  if (learningAfter !== learningBefore) writeFileSync(learningPath, learningAfter, 'utf8');
  console.log(`[ACTUAL_TRADE_LEARNING_COMPAT] prepared server/engineTradeLearning.js${learningAfter !== learningBefore ? ' (normalized)' : ''}`);

  const isolationPath = resolve(root, 'scripts/apply_account_engine_isolation.mjs');
  const isolationBefore = readFileSync(isolationPath, 'utf8');
  const guardMarker = "source.includes(\"source: 'end-of-day-market-review'\")";
  const schedulerAnchor = "  patchFile(root, 'server/ictAutoScheduler.js', (source) => {\n    let out = source;";
  const schedulerGuard = "  patchFile(root, 'server/ictAutoScheduler.js', (source) => {\n    // The 17:30 ET review already performs broker sync -> trade learning -> market study -> Edge Learning.\n    // Do not reapply the legacy startup/daily-study account-backfill rewrite to that evolved scheduler.\n    if (\n      source.includes(\"source: 'end-of-day-market-review'\") &&\n      source.includes('accountAccuracy: tradeReview')\n    ) {\n      return source;\n    }\n    let out = source;";
  let isolationAfter = isolationBefore;
  if (!isolationAfter.includes(guardMarker)) {
    if (!isolationAfter.includes(schedulerAnchor)) {
      throw new Error('[ACTUAL_TRADE_LEARNING_COMPAT] account isolation scheduler anchor missing');
    }
    isolationAfter = isolationAfter.replace(schedulerAnchor, schedulerGuard);
  }
  if (isolationAfter !== isolationBefore) writeFileSync(isolationPath, isolationAfter, 'utf8');
  console.log(`[ACTUAL_TRADE_LEARNING_COMPAT] prepared scripts/apply_account_engine_isolation.mjs${isolationAfter !== isolationBefore ? ' (17:30 review compatible)' : ''}`);

  return {
    changed: learningAfter !== learningBefore || isolationAfter !== isolationBefore,
    learningChanged: learningAfter !== learningBefore,
    accountIsolationChanged: isolationAfter !== isolationBefore,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareActualTradeLearningCompatibility();
}
