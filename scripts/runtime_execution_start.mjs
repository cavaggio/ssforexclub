import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyIctRrFloorRuntime } from './apply_ict_rr_floor_runtime.mjs';
import { applyManualTargetRiskRuntime } from './apply_manual_target_risk_runtime.mjs';
import { prepareEngineTradeLearningCompatibility } from './prepare_engine_trade_learning_compat.mjs';
import { applyEngineTradeLearningPatch } from './apply_engine_trade_learning.mjs';
import { applyAccountEngineIsolation } from './apply_account_engine_isolation.mjs';
import { restoreV3WatchlistCompatibility } from './restore_v3_watchlist_compat.mjs';
import { prepareActualTradeLearningCompatibility } from './prepare_actual_trade_learning_compat.mjs';
import { applyActualTradeLearningView } from './apply_actual_trade_learning_view.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled', 'active']);
const ICT_ENGINE_PATH = resolve(ROOT, 'server/ictEngine.js');
const ICT_RR_RUNTIME_MARKERS = [
  'export const ICT_MIN_RR = 1.5;',
  'minRR: configuredIctMinRR()',
  'export function enforceMinimumRRTarget',
  'const targetPolicy = enforceMinimumRRTarget({',
  'targetAdjustedToMinRR',
  'minimumRR: configuredIctMinRR()',
];

function truthy(value) {
  return TRUE_VALUES.has(String(value || '').trim().toLowerCase());
}

function finiteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function enforceRuntimeFloors() {
  // These are execution contracts, not optional tuning suggestions. A stale or
  // accidentally loosened Railway variable must never make the runtime less safe
  // or contradict the scanner's qualified status.
  process.env.ICT_EXECUTION_MIN_CONFIDENCE = String(Math.max(80, finiteNumber(process.env.ICT_EXECUTION_MIN_CONFIDENCE, 80)));
  process.env.ICT_MIN_RR = String(Math.max(1.5, finiteNumber(process.env.ICT_MIN_RR, 1.5)));
  process.env.ICT_MAX_RISK_PERCENT = String(Math.min(1, Math.max(0.01, finiteNumber(process.env.ICT_MAX_RISK_PERCENT, 1))));
  process.env.RISK_MAX_PER_TRADE_PERCENT = String(Math.min(1, Math.max(0.01, finiteNumber(process.env.RISK_MAX_PER_TRADE_PERCENT, 1))));
  process.env.RISK_DAILY_MAX_DRAWDOWN_PERCENT = String(Math.min(2, Math.max(0.01, finiteNumber(process.env.RISK_DAILY_MAX_DRAWDOWN_PERCENT, 2))));
  process.env.RISK_POST_LOSS_NEXT_TRADE_PERCENT = String(Math.min(0.5, Math.max(0.01, finiteNumber(process.env.RISK_POST_LOSS_NEXT_TRADE_PERCENT, 0.5))));
}

function hasIctRrRuntimeContract(source) {
  return ICT_RR_RUNTIME_MARKERS.every((marker) => source.includes(marker));
}

function ensureIctRrFloorRuntime() {
  // The build-time source pipeline runs before Railway starts and newer ICT
  // policy passes may append adaptive-stop metadata to computeSetup. The legacy
  // runtime patcher matches the original block byte-for-byte, so do not rerun it
  // when the stable R:R contract is already present in the evolved source.
  const before = readFileSync(ICT_ENGINE_PATH, 'utf8');
  if (hasIctRrRuntimeContract(before)) {
    console.log('[RUNTIME_EXECUTION_START] ICT R:R floor already enforced by build pipeline');
    return;
  }

  applyIctRrFloorRuntime();

  const after = readFileSync(ICT_ENGINE_PATH, 'utf8');
  const missing = ICT_RR_RUNTIME_MARKERS.filter((marker) => !after.includes(marker));
  if (missing.length) {
    throw new Error(`ICT R:R runtime enforcement incomplete after patch: ${missing.join(', ')}`);
  }
}

function patchFile(relativePath, patcher, requiredMarkers) {
  const path = resolve(ROOT, relativePath);
  const before = readFileSync(path, 'utf8');
  const after = patcher(before);
  const missing = requiredMarkers.filter((marker) => !after.includes(marker));
  if (missing.length) {
    throw new Error(`${relativePath} missing required runtime execution markers: ${missing.join(', ')}`);
  }
  if (after !== before) writeFileSync(path, after, 'utf8');
  console.log(`[RUNTIME_EXECUTION_START] verified ${relativePath}${after !== before ? ' (patched)' : ''}`);
}

enforceRuntimeFloors();
ensureIctRrFloorRuntime();
prepareEngineTradeLearningCompatibility(ROOT);
await import('./apply_daily_ict_policy.mjs');
await import('./apply_daily_bot_policy.mjs');
await import('./apply_daily_risk_persistence.mjs');
await import('./apply_signal_forensics_alignment_v3.mjs');
await import('./cleanup_signal_forensics_alignment.mjs');
applyEngineTradeLearningPatch(ROOT);
prepareActualTradeLearningCompatibility(ROOT);
applyAccountEngineIsolation(ROOT);
restoreV3WatchlistCompatibility(ROOT);
applyActualTradeLearningView(ROOT);

// Manual target-risk propagation is a compatibility patch, not a prerequisite
// for starting the API. A stale source marker must never take the entire scanner,
// active-trade monitor, reassessor, and calibration endpoints offline. The
// execution modules still enforce the central 1% risk cap independently.
try {
  applyManualTargetRiskRuntime();
} catch (error) {
  console.error(
    `[RUNTIME_EXECUTION_START] manual target-risk compatibility patch skipped: ${error instanceof Error ? error.message : String(error)}`,
  );
}

patchFile(
  'server/ictEngine.js',
  (source) => source
    .replace(
      "export function isIctEnabled() { return ICT_MODE === 'shadow' || ICT_MODE === 'live'; }",
      "export function isIctEnabled() { return ICT_MODE === 'shadow' || ICT_MODE === 'active' || ICT_MODE === 'live'; }",
    )
    .replace(
      /minConfidence:\s*Math\.max\((?:80|85|93),\s*parseFloat\(process\.env\.ICT_EXECUTION_MIN_CONFIDENCE \|\| '(?:80|85|93)'\)\)/,
      "minConfidence: Math.max(80, parseFloat(process.env.ICT_EXECUTION_MIN_CONFIDENCE || '80'))",
    )
    .replace(
      /minRR:\s*(?:Math\.max\(1\.5,\s*)?parseFloat\(process\.env\.ICT_MIN_RR \|\| '(?:1|1\.0|1\.5|2|2\.0)'\)\)?/,
      "minRR: Math.max(1.5, parseFloat(process.env.ICT_MIN_RR || '1.5'))",
    )
    .replace(
      /const MIN_RR = (?:Math\.max\(1\.5,\s*)?parseFloat\(process\.env\.ICT_MIN_RR \|\| '(?:1|1\.0|1\.5|2|2\.0)'\)\)?;/,
      "const MIN_RR = Math.max(1.5, parseFloat(process.env.ICT_MIN_RR || '1.5'));",
    )
    .replace(
      /return c\.mode === 'live' && c\.autoTradeEnabled === true;/,
      "return (c.mode === 'active' || c.mode === 'live') && c.autoTradeEnabled === true;",
    ),
  [
    "ICT_MODE === 'active'",
    "Math.max(80, parseFloat(process.env.ICT_EXECUTION_MIN_CONFIDENCE || '80'))",
    'export const ICT_MIN_RR = 1.5;',
    'minRR: configuredIctMinRR()',
    'export function enforceMinimumRRTarget',
    'const targetPolicy = enforceMinimumRRTarget({',
    "(c.mode === 'active' || c.mode === 'live') && c.autoTradeEnabled === true",
  ],
);

patchFile(
  'server/ictExecution.js',
  (source) => {
    let out = source
      .replace(
        /if \(!\(config\.mode === 'live' && config\.autoTradeEnabled === true\)\) \{/,
        "if (!((config.mode === 'active' || config.mode === 'live') && config.autoTradeEnabled === true)) {",
      )
      .replace(
        /if \(!\(\(config\.mode === 'live'\) && config\.autoTradeEnabled === true\)\) \{/,
        "if (!((config.mode === 'active' || config.mode === 'live') && config.autoTradeEnabled === true)) {",
      );

    if (!out.includes("config.mode === 'active' || config.mode === 'live'")) {
      throw new Error('ICT execution mode patch did not apply');
    }
    return out;
  },
  ["config.mode === 'active' || config.mode === 'live'"],
);

await import('../server/index.js');
