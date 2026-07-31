import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyActualTradeLearningView } from './apply_actual_trade_learning_view.mjs';
import { maybeRebaseIctTarget } from '../server/ictExecutionTarget.js';

const source = readFileSync(new URL('../server/engineTradeLearning.js', import.meta.url), 'utf8');
const ictEngineSource = readFileSync(new URL('../server/ictEngine.js', import.meta.url), 'utf8');
const ictExecutionSource = readFileSync(new URL('../server/ictExecution.js', import.meta.url), 'utf8');

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

test('final runtime pass restores the 80% ICT floor and bounded executable-price target correction', () => {
  const root = mkdtempSync(join(tmpdir(), 'ict-runtime-gate-fix-'));
  try {
    mkdirSync(join(root, 'server'), { recursive: true });
    writeFileSync(join(root, 'server/engineTradeLearning.js'), source, 'utf8');
    writeFileSync(join(root, 'server/ictEngine.js'), ictEngineSource, 'utf8');
    writeFileSync(join(root, 'server/ictExecution.js'), ictExecutionSource, 'utf8');

    applyActualTradeLearningView(root);
    const engine = readFileSync(join(root, 'server/ictEngine.js'), 'utf8');
    const execution = readFileSync(join(root, 'server/ictExecution.js'), 'utf8');

    assert.match(engine, /ICT_EXECUTION_MIN_CONFIDENCE \|\| '80'/);
    assert.doesNotMatch(engine, /minConfidence: Math\.max\(93/);
    assert.match(execution, /minConfidence: Math\.max\(80/);
    assert.match(execution, /maybeRebaseIctTarget/);
    assert.match(execution, /executionTargetRebase/);

    const engineOnce = engine;
    const executionOnce = execution;
    applyActualTradeLearningView(root);
    assert.equal(readFileSync(join(root, 'server/ictEngine.js'), 'utf8'), engineOnce);
    assert.equal(readFileSync(join(root, 'server/ictExecution.js'), 'utf8'), executionOnce);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a 0.04R fresh-quote shortfall rebases TP instead of rejecting a scanner-qualified 1.50R setup', () => {
  const result = maybeRebaseIctTarget({
    pair: 'EUR_USD',
    direction: 'long',
    executablePrice: 1.14868,
    stopLoss: 1.14744,
    currentTarget: 1.15049,
    scannerRR: 1.5,
    executableRR: 1.46,
    minimumRR: 1.5,
    maxShortfallR: 0.10,
    maxExtensionPips: 2,
  });

  assert.equal(result.adjusted, true);
  assert.equal(result.targetProfit, 1.15054);
  assert.equal(result.rebasedRR, 1.5);
  assert.ok(result.extensionPips <= 2);
});

test('a large executable R:R collapse is still rejected rather than stretching TP', () => {
  const result = maybeRebaseIctTarget({
    pair: 'EUR_USD',
    direction: 'long',
    executablePrice: 1.14920,
    stopLoss: 1.14744,
    currentTarget: 1.15049,
    scannerRR: 1.5,
    executableRR: 0.73,
    minimumRR: 1.5,
    maxShortfallR: 0.10,
    maxExtensionPips: 2,
  });

  assert.equal(result.adjusted, false);
  assert.equal(result.reason, 'rr_shortfall_exceeds_tolerance');
});
