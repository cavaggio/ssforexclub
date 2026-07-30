import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySignalExecutionQualitySeparation } from './apply_signal_execution_quality_separation.mjs';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function applyActualTradeLearningView(root = DEFAULT_ROOT) {
  const path = resolve(root, 'server/engineTradeLearning.js');
  const before = readFileSync(path, 'utf8');
  let after = before
    .replaceAll("loadRows('engine_executed_pair_stats'", "loadRows('engine_combined_pair_stats'")
    .replaceAll("loadRows('engine_account_pair_accuracy_7d'", "loadRows('engine_actual_account_pair_accuracy_7d'")
    .replaceAll("loadAccountRows('engine_account_accuracy_7d'", "loadAccountRows('engine_actual_account_accuracy_7d'")
    .replace(
      /engine_executed_\|engine_account_accuracy_7d\|engine_account_pair_accuracy_7d\|engine_learning_adjustment_audit/,
      'engine_executed_|engine_combined_pair_stats|engine_actual_account_accuracy_7d|engine_actual_account_pair_accuracy_7d|engine_learning_adjustment_audit',
    )
    .replace(
      'migration 20260730110000_engine_trade_learning.sql is required; market study remains active',
      'migrations 20260730110000 and 20260730162000 are required; market study remains active',
    );

  const required = [
    "loadRows('engine_combined_pair_stats'",
    "loadRows('engine_actual_account_pair_accuracy_7d'",
    "loadAccountRows('engine_actual_account_accuracy_7d'",
  ];
  const missing = required.filter((marker) => !after.includes(marker));
  if (missing.length) {
    throw new Error(`[ACTUAL_TRADE_LEARNING] missing runtime markers: ${missing.join(', ')}`);
  }
  if (after !== before) writeFileSync(path, after, 'utf8');
  console.log(`[ACTUAL_TRADE_LEARNING] verified server/engineTradeLearning.js${after !== before ? ' (patched)' : ''}`);

  // Apply signal/execution quality separation only after the actual-trade view
  // owns pair expectancy, so thesis confidence never absorbs entry/fill drag.
  applySignalExecutionQualitySeparation(root);
  return { changed: after !== before, source: after };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  applyActualTradeLearningView();
}
