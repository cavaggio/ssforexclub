import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyActualTradeLearningView } from './apply_actual_trade_learning_view.mjs';
import { maybeRebaseIctTarget } from '../server/ictExecutionTarget.js';

const source = readFileSync(new URL('../server/engineTradeLearning.js', import.meta.url), 'utf8');
const ictEngineSource = readFileSync(new URL('../server/ictEngine.js', import.meta.url), 'utf8');
const ictAutoTradeSource = readFileSync(new URL('../server/ictAutoTrade.js', import.meta.url), 'utf8');
const ictExecutionSource = readFileSync(new URL('../server/ictExecution.js', import.meta.url), 'utf8');
const runtimeStartSource = readFileSync(new URL('./runtime_execution_start.mjs', import.meta.url), 'utf8');
const legacyRuntimeStartSource = runtimeStartSource
  .replaceAll('ICT_EXECUTION_MIN_CONFIDENCE', 'ICT_MIN_CONFIDENCE')
  .replaceAll('Math.max(80', 'Math.max(93')
  .replaceAll("'80'", "'93'");
const legacyAutoTradeSource = ictAutoTradeSource.replace(
  /((?:export\s+)?function buildIctWatchState\(analyses = \[\], minConfidence = )80(, minRR = 1\.5\))?/,
  (_, prefix, minRrSuffix = '') => `${prefix}93${minRrSuffix}`,
);

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

test('final runtime pass restores the 80% ICT floor and pair-accurate executable target correction', () => {
  const root = mkdtempSync(join(tmpdir(), 'ict-runtime-gate-fix-'));
  try {
    mkdirSync(join(root, 'server'), { recursive: true });
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'server/engineTradeLearning.js'), source, 'utf8');
    writeFileSync(join(root, 'server/ictEngine.js'), ictEngineSource, 'utf8');
    writeFileSync(join(root, 'server/ictAutoTrade.js'), legacyAutoTradeSource, 'utf8');
    writeFileSync(join(root, 'server/ictExecution.js'), ictExecutionSource, 'utf8');
    writeFileSync(join(root, 'scripts/runtime_execution_start.mjs'), legacyRuntimeStartSource, 'utf8');

    applyActualTradeLearningView(root);
    const engine = readFileSync(join(root, 'server/ictEngine.js'), 'utf8');
    const autoTrade = readFileSync(join(root, 'server/ictAutoTrade.js'), 'utf8');
    const execution = readFileSync(join(root, 'server/ictExecution.js'), 'utf8');
    const runtimeStart = readFileSync(join(root, 'scripts/runtime_execution_start.mjs'), 'utf8');

    assert.match(engine, /ICT_EXECUTION_MIN_CONFIDENCE \|\| '80'/);
    assert.doesNotMatch(engine, /minConfidence: Math\.max\(93/);
    assert.match(autoTrade, /buildIctWatchState\(analyses = \[\], minConfidence = 80, minRR = 1\.5\)/);
    assert.match(autoTrade, /confidence >= cfg\.minConfidence/);
    assert.match(execution, /minConfidence: Math\.max\(80/);
    assert.match(execution, /maybeRebaseIctTarget/);
    assert.match(execution, /selectIctPairQuote\(pricingPayload, pair\)/);
    assert.match(execution, /Final executable-price confirmation rejected for \$\{pair\}/);
    assert.match(execution, /sizing = computeFixedDollarSizing/);
    assert.match(execution, /executionTargetRebase/);
    assert.match(runtimeStart, /process\.env\.ICT_EXECUTION_MIN_CONFIDENCE = String\(Math\.max\(80,/);
    assert.doesNotMatch(runtimeStart, /Math\.max\(93/);

    const engineOnce = engine;
    const autoTradeOnce = autoTrade;
    const executionOnce = execution;
    const runtimeStartOnce = runtimeStart;
    applyActualTradeLearningView(root);
    assert.equal(readFileSync(join(root, 'server/ictEngine.js'), 'utf8'), engineOnce);
    assert.equal(readFileSync(join(root, 'server/ictAutoTrade.js'), 'utf8'), autoTradeOnce);
    assert.equal(readFileSync(join(root, 'server/ictExecution.js'), 'utf8'), executionOnce);
    assert.equal(readFileSync(join(root, 'scripts/runtime_execution_start.mjs'), 'utf8'), runtimeStartOnce);
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
    maxExtensionPips: 2,
  });

  assert.equal(result.adjusted, true);
  assert.equal(result.targetProfit, 1.15054);
  assert.equal(result.rebasedRR, 1.5);
  assert.ok(result.extensionPips <= 2);
});

test('a genuine large executable R:R collapse remains rejected by the pair-priced TP cap', () => {
  const result = maybeRebaseIctTarget({
    pair: 'EUR_USD',
    direction: 'long',
    executablePrice: 1.14920,
    stopLoss: 1.14744,
    currentTarget: 1.15049,
    scannerRR: 1.5,
    executableRR: 0.73,
    minimumRR: 1.5,
    maxExtensionPips: 2,
  });

  assert.equal(result.adjusted, false);
  assert.equal(result.reason, 'target_extension_exceeds_cap');
  assert.match(result.blocker, /EUR_USD/);
  assert.match(result.blocker, /execution cap/);
});
