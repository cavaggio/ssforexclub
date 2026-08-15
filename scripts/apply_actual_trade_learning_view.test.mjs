import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyActualTradeLearningView } from './apply_actual_trade_learning_view.mjs';
import { patchQualifiedRejectionAudit } from './apply_qualified_rejection_audit.mjs';
import {
  patchExactIctConfidenceSource,
  patchManualTargetRiskIndex,
} from './apply_runtime_log_findings.mjs';
import { maybeRebaseIctTarget } from '../server/ictExecutionTarget.js';

const source = readFileSync(new URL('../server/engineTradeLearning.js', import.meta.url), 'utf8');
const threeDatasetMigration = readFileSync(
  new URL('../supabase/migrations/20260815120000_three_dataset_engine_learning.sql', import.meta.url),
  'utf8',
);
const ictEngineSource = readFileSync(new URL('../server/ictEngine.js', import.meta.url), 'utf8');
const ictAutoTradeSource = readFileSync(new URL('../server/ictAutoTrade.js', import.meta.url), 'utf8');
const ictExecutionSource = readFileSync(new URL('../server/ictExecution.js', import.meta.url), 'utf8');
const serverIndexSource = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const autoAiRouteSource = readFileSync(new URL('../web/app/api/cron/auto-ai-trading-extended/route.ts', import.meta.url), 'utf8');
const runtimeStartSource = readFileSync(new URL('./runtime_execution_start.mjs', import.meta.url), 'utf8');
const legacyRuntimeStartSource = runtimeStartSource
  .replaceAll('ICT_EXECUTION_MIN_CONFIDENCE', 'ICT_MIN_CONFIDENCE')
  .replaceAll('Math.max(75', 'Math.max(93')
  .replaceAll("'75'", "'93'");
const legacyAutoTradeSource = ictAutoTradeSource.replace(
  /((?:export\s+)?function buildIctWatchState\(analyses = \[\], minConfidence = )75(, minRR = 1\.5\))?/,
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
    assert.match(first.source, /engine_signal_learning_stats/);
    assert.match(first.source, /engine_learning_adjustment_effectiveness_stats/);
    assert.equal(second.changed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('account-level actual-trade accuracy is queried without a nonexistent horizon column', () => {
  const accountLoader = source.match(/async function loadAccountRows[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(accountLoader, /engine/);
  assert.doesNotMatch(accountLoader, /horizon_minutes/);
});

test('three-dataset migration reports its prerequisite migration order before changing schema', () => {
  assert.match(threeDatasetMigration, /to_regclass\(required_relation\)/);
  assert.match(threeDatasetMigration, /20260727210000/);
  assert.match(threeDatasetMigration, /20260730110000/);
  assert.match(threeDatasetMigration, /20260730143000/);
  assert.match(threeDatasetMigration, /20260730162000/);
  assert.match(threeDatasetMigration, /20260730162500/);
  assert.ok(
    threeDatasetMigration.indexOf('do $$') <
      threeDatasetMigration.indexOf('alter table public.actual_trade_lifecycles'),
  );
});

test('final runtime pass fixes the ICT threshold at exactly 75 and keeps scanner qualification authoritative', () => {
  const root = mkdtempSync(join(tmpdir(), 'ict-runtime-gate-fix-'));
  try {
    mkdirSync(join(root, 'server'), { recursive: true });
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'web/app/api/cron/auto-ai-trading-extended'), { recursive: true });
    writeFileSync(join(root, 'server/engineTradeLearning.js'), source, 'utf8');
    writeFileSync(join(root, 'server/ictEngine.js'), ictEngineSource, 'utf8');
    writeFileSync(join(root, 'server/ictAutoTrade.js'), legacyAutoTradeSource, 'utf8');
    writeFileSync(join(root, 'server/ictExecution.js'), ictExecutionSource, 'utf8');
    writeFileSync(join(root, 'server/index.js'), serverIndexSource, 'utf8');
    writeFileSync(join(root, 'web/app/api/cron/auto-ai-trading-extended/route.ts'), autoAiRouteSource, 'utf8');
    writeFileSync(join(root, 'scripts/runtime_execution_start.mjs'), legacyRuntimeStartSource, 'utf8');

    applyActualTradeLearningView(root);
    const engine = readFileSync(join(root, 'server/ictEngine.js'), 'utf8');
    const autoTrade = readFileSync(join(root, 'server/ictAutoTrade.js'), 'utf8');
    const execution = readFileSync(join(root, 'server/ictExecution.js'), 'utf8');
    const index = readFileSync(join(root, 'server/index.js'), 'utf8');
    const runtimeStart = readFileSync(join(root, 'scripts/runtime_execution_start.mjs'), 'utf8');

    assert.match(engine, /minConfidence: 75,/);
    assert.doesNotMatch(engine, /minConfidence: Math\.max\((?:85|93)/);
    assert.match(autoTrade, /buildIctWatchState\(analyses = \[\], minConfidence = 75, minRR = 1\.5\)/);
    assert.match(autoTrade, /confidence >= cfg\.minConfidence/);
    assert.match(execution, /minConfidence: 75,/);
    assert.match(execution, /maybeRebaseIctTarget/);
    assert.match(execution, /selectIctPairQuote\(pricingPayload, pair\)/);
    assert.match(execution, /Final executable-price confirmation rejected for \$\{pair\}/);
    assert.match(execution, /sizing = computeFixedDollarSizing/);
    assert.match(execution, /executionTargetRebase/);
    assert.match(execution, /authoritativeAnalysis = null/);
    assert.match(execution, /executionQualifiedSnapshotGrace/);
    assert.match(execution, /const rawFreshSpreadPips =/);
    assert.ok(execution.includes('ICT_MAX_SPREAD_PIPS_${pair}'));
    assert.match(execution, /normalizedSpreadPips/);
    assert.match(execution, /scannerQualifiedSwing: true/);
    assert.match(execution, /ictScannerAuthoritative: true/);
    assert.match(execution, /optional stop advice ignored for \$\{pair\}/);
    assert.match(execution, /stopLoss = authoritativeStop/);
    assert.doesNotMatch(execution, /Scalp-only execution: ICT swing trade signals are disabled/);
    assert.doesNotMatch(execution, /Universal entry policy:/);
    assert.match(index, /deriveQualifiedManualRisk/);
    assert.match(index, /targetRiskUSD: manualRisk\.targetRiskUSD/);
    assert.match(index, /qualified_signal_button_ppr/);
    assert.match(runtimeStart, /process\.env\.ICT_EXECUTION_MIN_CONFIDENCE = String\(Math\.max\(75,/);
    assert.doesNotMatch(runtimeStart, /Math\.max\(93/);
    assert.equal(process.env.ICT_EXECUTION_MIN_CONFIDENCE, '75');

    const engineOnce = engine;
    const autoTradeOnce = autoTrade;
    const executionOnce = execution;
    const indexOnce = index;
    const runtimeStartOnce = runtimeStart;
    applyActualTradeLearningView(root);
    assert.equal(readFileSync(join(root, 'server/ictEngine.js'), 'utf8'), engineOnce);
    assert.equal(readFileSync(join(root, 'server/ictAutoTrade.js'), 'utf8'), autoTradeOnce);
    assert.equal(readFileSync(join(root, 'server/ictExecution.js'), 'utf8'), executionOnce);
    assert.equal(readFileSync(join(root, 'server/index.js'), 'utf8'), indexOnce);
    assert.equal(readFileSync(join(root, 'scripts/runtime_execution_start.mjs'), 'utf8'), runtimeStartOnce);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stale Railway configuration cannot override the approved ICT 75 percent threshold', () => {
  const engine = patchExactIctConfidenceSource(
    "return { minConfidence: Math.max(75, parseFloat(process.env.ICT_EXECUTION_MIN_CONFIDENCE || '75')), minRR: 1.5 };",
    'engine',
  );
  const execution = patchExactIctConfidenceSource(
    'return { minConfidence: Math.max(75, Number(rawConfig?.minConfidence) || 75), minRR: 1.5 };',
    'execution',
  );
  assert.match(engine, /minConfidence: 75,/);
  assert.match(execution, /minConfidence: 75,/);
});

test('manual target-risk patch supports the current combined risk-manager import', () => {
  const patched = patchManualTargetRiskIndex(serverIndexSource);
  assert.match(patched, /deriveQualifiedManualRisk/);
  assert.match(patched, /targetRiskUSD: manualRisk\.targetRiskUSD/);
  assert.match(patched, /manualExecution: true/);
  assert.match(patched, /qualified_signal_button_ppr/);
  assert.equal(patchManualTargetRiskIndex(patched), patched);
});

test('qualified execution skips are persisted with the matching signal and concrete reason', () => {
  const patched = patchQualifiedRejectionAudit(autoAiRouteSource);
  assert.match(patched, /const skippedList = Array\.isArray\(payload\.skipped\)/);
  assert.match(patched, /executionSource: 'auto_ai_qualified_rejection'/);
  assert.match(patched, /eventType: 'error'/);
  assert.match(patched, /rejection: item/);
  assert.match(patched, /signal,/);
  assert.equal(patchQualifiedRejectionAudit(patched), patched);
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
