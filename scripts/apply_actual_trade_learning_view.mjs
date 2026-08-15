import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySignalExecutionQualitySeparation } from './apply_signal_execution_quality_separation.mjs';
import { applyIctRuntimeGateFix } from './apply_ict_runtime_gate_fix.mjs';
import { applyIctQualifiedGateConsistency } from './apply_ict_qualified_gate_consistency.mjs';
import { applyIctQualificationAuthority } from './apply_ict_qualification_authority.mjs';
import { applyQualifiedRejectionAudit } from './apply_qualified_rejection_audit.mjs';
import { applyScanRejectionDiagnostics } from './apply_scan_rejection_diagnostics.mjs';
import { applyRuntimeLogFindings } from './apply_runtime_log_findings.mjs';
import { applyOandaExecutableQuoteFix } from './apply_oanda_executable_quote_fix.mjs';

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
    )
    .replace(
      'migrations 20260730110000 and 20260730162000 are required; market study remains active',
      'migrations 20260730110000, 20260730162000 and 20260815120000 are required; market study remains active',
    );

  const required = [
    "loadRows('engine_combined_pair_stats'",
    "loadRows('engine_actual_account_pair_accuracy_7d'",
    "loadAccountRows('engine_actual_account_accuracy_7d'",
    "loadRows('engine_signal_learning_stats'",
    "loadRows('engine_learning_adjustment_effectiveness_stats'",
  ];
  const missing = required.filter((marker) => !after.includes(marker));
  if (missing.length) {
    throw new Error(`[ACTUAL_TRADE_LEARNING] missing runtime markers: ${missing.join(', ')}`);
  }
  if (after !== before) writeFileSync(path, after, 'utf8');
  console.log(`[ACTUAL_TRADE_LEARNING] verified server/engineTradeLearning.js${after !== before ? ' (patched)' : ''}`);

  // Minimal unit-test fixtures intentionally contain only engineTradeLearning.js.
  // Production/runtime trees contain both files and always receive the patch.
  const targetConfidencePath = resolve(root, 'server/ictTargetConfidence.js');
  const qualityModulePath = resolve(root, 'server/signalExecutionQuality.js');
  if (existsSync(targetConfidencePath) && existsSync(qualityModulePath)) {
    applySignalExecutionQualitySeparation(root);
  }

  // This runs last in prestart, after the legacy generators and account-isolation
  // passes, so execution accuracy, its audit trail, exact scan reasons, and the
  // approved 75% ICT threshold cannot be overwritten before scanning begins.
  const ictEnginePath = resolve(root, 'server/ictEngine.js');
  const ictExecutionPath = resolve(root, 'server/ictExecution.js');
  const serverIndexPath = resolve(root, 'server/index.js');
  if (existsSync(ictEnginePath) && existsSync(ictExecutionPath)) {
    const engineSource = readFileSync(ictEnginePath, 'utf8');
    const executionSource = readFileSync(ictExecutionPath, 'utf8');
    const exactThresholdAlreadyApplied =
      engineSource.includes('minConfidence: 75,') &&
      executionSource.includes('minConfidence: 75,');
    if (!exactThresholdAlreadyApplied) {
      applyIctRuntimeGateFix(root);
    } else {
      console.log('[ACTUAL_TRADE_LEARNING] exact ICT 75% runtime gate already applied');
    }
  }

  const executionSource = existsSync(ictExecutionPath)
    ? readFileSync(ictExecutionPath, 'utf8')
    : '';
  const indexSource = existsSync(serverIndexPath)
    ? readFileSync(serverIndexPath, 'utf8')
    : '';
  const qualifiedRouteAlreadyApplied =
    executionSource.includes('executionQualifiedSnapshotGrace') &&
    indexSource.includes('signalConfidence, signalRR, manualExecution, executionSource') &&
    indexSource.includes('targetRiskUSD: manualRisk.targetRiskUSD');
  if (!qualifiedRouteAlreadyApplied) {
    applyIctQualifiedGateConsistency(root);
  } else {
    console.log('[ACTUAL_TRADE_LEARNING] qualified ICT route and manual-risk propagation already applied');
  }

  applyIctQualificationAuthority(root);
  applyQualifiedRejectionAudit(root);
  applyScanRejectionDiagnostics(root);
  applyRuntimeLogFindings(root);
  applyOandaExecutableQuoteFix(root);

  return { changed: after !== before, source: after };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  applyActualTradeLearningView();
}
