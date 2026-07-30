import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyActualTradeLearningView } from './apply_actual_trade_learning_view.mjs';

const source = readFileSync(new URL('../server/engineTradeLearning.js', import.meta.url), 'utf8');

test('actual-trade learning patch is idempotent after account-isolation source generation', () => {
  const root = mkdtempSync(join(tmpdir(), 'actual-trade-learning-'));
  try {
    mkdirSync(join(root, 'server'), { recursive: true });
    writeFileSync(join(root, 'server/engineTradeLearning.js'), source, 'utf8');
    const first = applyActualTradeLearningView(root);
    const second = applyActualTradeLearningView(root);
    assert.match(first.source, /engine_combined_pair_stats/);
    assert.match(first.source, /engine_actual_account_pair_accuracy_7d/);
    assert.match(first.source, /engine_actual_account_accuracy_7d/);
    assert.equal(second.changed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
