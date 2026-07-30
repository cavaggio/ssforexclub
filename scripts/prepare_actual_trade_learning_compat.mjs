import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function prepareActualTradeLearningCompatibility(root = DEFAULT_ROOT) {
  const path = resolve(root, 'server/engineTradeLearning.js');
  const before = readFileSync(path, 'utf8');
  const after = before
    .replaceAll("loadRows('engine_combined_pair_stats'", "loadRows('engine_executed_pair_stats'")
    .replaceAll("loadRows('engine_actual_account_pair_accuracy_7d'", "loadRows('engine_account_pair_accuracy_7d'")
    .replaceAll("loadAccountRows('engine_actual_account_accuracy_7d'", "loadAccountRows('engine_account_accuracy_7d'");
  if (after !== before) writeFileSync(path, after, 'utf8');
  console.log(`[ACTUAL_TRADE_LEARNING_COMPAT] prepared server/engineTradeLearning.js${after !== before ? ' (normalized)' : ''}`);
  return { changed: after !== before };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareActualTradeLearningCompatibility();
}
