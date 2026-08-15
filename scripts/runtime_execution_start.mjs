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
const ICT_EXECUTION_PATH = resolve(ROOT, 'server/ictExecution.js');
const ICT_AUTO_TRADE_PATH = resolve(ROOT, 'server/ictAutoTrade.js');
const SERVER_INDEX_PATH = resolve(ROOT, 'server/index.js');
const ICT_RR_RUNTIME_MARKERS = [
  'export const ICT_MIN_RR = 1.5;',
  'minRR: configuredIctMinRR()',
  'export function enforceMinimumRRTarget',
  'const targetPolicy = enforceMinimumRRTarget({',
  'targetAdjustedToMinRR',
  'minimumRR: configuredIctMinRR()',
];
const SIGNAL_FORENSICS_RUNTIME_MARKERS = [
  'export function maskAccountForLog',
  'export function buildIctWatchState',
  'hasBlockingHardReject(item)',
  'hasExecutableGeometry(item, cfg.minRR)',
  'buildIctWatchState(analyses, cfg.minConfidence, cfg.minRR)',
];

function truthy(value) {
  return TRUE_VALUES.has(String(value || '').trim().toLowerCase());
}

function finiteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function enforceRuntimeFloors() {
  process.env.ICT_EXECUTION_MIN_CONFIDENCE = String(Math.max(75, Math.min(75, finiteNumber(process.env.ICT_EXECUTION_MIN_CONFIDENCE, 75))));
  // These are execution contracts, not optional tuning suggestions. A stale or
  // accidentally loosened Railway variable must never make the runtime less safe
  // or contradict the scanner's qualified status.
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

async function ensureSignalForensicsRuntime() {
  const before = readFileSync(ICT_AUTO_TRADE_PATH, 'utf8');
  if (SIGNAL_FORENSICS_RUNTIME_MARKERS.every((marker) => before.includes(marker))) {
    console.log('[RUNTIME_EXECUTION_START] signal-forensics contract already enforced by build pipeline');
    return;
  }

  // Signal-forensics is a compatibility/source-generation pass. A stale source
  // anchor must never crash Railway and take all scanner/execution endpoints down.
  try {
    await import('./apply_signal_forensics_alignment_v3.mjs');
  } catch (error) {
    console.error(
      `[RUNTIME_EXECUTION_START] optional signal-forensics compatibility patch skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  const after = readFileSync(ICT_AUTO_TRADE_PATH, 'utf8');
  const missing = SIGNAL_FORENSICS_RUNTIME_MARKERS.filter((marker) => !after.includes(marker));
  if (missing.length) {
    console.error(`[RUNTIME_EXECUTION_START] signal-forensics runtime markers still missing: ${missing.join(', ')}`);
  }
}

function hasEquivalentIctStudyCalibration(source) {
  return [
    "applyStoredStudyCalibration(await analyze(pair), { client, engine: 'ict' })",
    "applyStoredStudyCalibration(rawAnalysis, { client, engine: 'ict' })",
    "applyCombinedLearningCalibration(rawAnalysis, { client, engine: 'ict' })",
  ].some((marker) => source.includes(marker));
}

async function ensureDailyIctPolicyRuntime() {
  try {
    await import('./apply_daily_ict_policy.mjs');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const execution = readFileSync(ICT_EXECUTION_PATH, 'utf8');
    const evolvedCalibrationOnly =
      message.includes("missing applyStoredStudyCalibration(await analyze(pair), { client, engine: 'ict' })") &&
      hasEquivalentIctStudyCalibration(execution) &&
      execution.includes('await hydrateDailyRiskState({ accountId: riskAccountId, balanceUSD, now });') &&
      execution.includes('markTradeOpened({ accountId, balanceUSD, now });') &&
      execution.includes('await persistDailyRiskState({ accountId, balanceUSD, now });');

    if (evolvedCalibrationOnly) {
      console.warn(
        '[RUNTIME_EXECUTION_START] accepted evolved ICT calibration path; legacy daily-policy literal marker is stale',
      );
      return;
    }
    throw error;
  }
}

function markerSatisfied(source, marker) {
  if (Array.isArray(marker)) return marker.some((candidate) => source.includes(candidate));
  return source.includes(marker);
}

function markerLabel(marker) {
  return Array.isArray(marker) ? `one of [${marker.join(' | ')}]` : marker;
}

function patchFile(relativePath, patcher, requiredMarkers) {
  const path = resolve(ROOT, relativePath);
  const before = readFileSync(path, 'utf8');
  const after = patcher(before);
  const missing = requiredMarkers.filter((marker) => !markerSatisfied(after, marker));
  if (missing.length) {
    throw new Error(`${relativePath} missing required runtime execution markers: ${missing.map(markerLabel).join(', ')}`);
  }
  if (after !== before) writeFileSync(path, after, 'utf8');
  console.log(`[RUNTIME_EXECUTION_START] verified ${relativePath}${after !== before ? ' (patched)' : ''}`);
}

enforceRuntimeFloors();
ensureIctRrFloorRuntime();
prepareEngineTradeLearningCompatibility(ROOT);
await ensureDailyIctPolicyRuntime();
await import('./apply_daily_bot_policy.mjs');
await import('./apply_daily_risk_persistence.mjs');
await ensureSignalForensicsRuntime();
await import('./cleanup_signal_forensics_alignment.mjs');
applyEngineTradeLearningPatch(ROOT);
prepareActualTradeLearningCompatibility(ROOT);
applyAccountEngineIsolation(ROOT);
restoreV3WatchlistCompatibility(ROOT);
applyActualTradeLearningView(ROOT);

// Manual target-risk propagation is a compatibility patch, not a prerequisite
// for starting the API. Skip the obsolete patcher when the final generated route
// already contains the trusted manual-risk contract.
const indexSource = readFileSync(SERVER_INDEX_PATH, 'utf8');
const manualRiskAlreadyApplied =
  indexSource.includes('targetRiskUSD: manualRisk.targetRiskUSD') &&
  indexSource.includes('manualExecution: manualExecution === true');
if (manualRiskAlreadyApplied) {
  console.log('[RUNTIME_EXECUTION_START] manual target-risk contract already enforced by final generator');
} else {
  try {
    applyManualTargetRiskRuntime();
  } catch (error) {
    console.error(
      `[RUNTIME_EXECUTION_START] manual target-risk compatibility patch skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

patchFile(
  'server/ictEngine.js',
  (source) => source
    .replace(
      "export function isIctEnabled() { return ICT_MODE === 'shadow' || ICT_MODE === 'live'; }",
      "export function isIctEnabled() { return ICT_MODE === 'shadow' || ICT_MODE === 'active' || ICT_MODE === 'live'; }",
    )
    .replace(
      /minConfidence:\s*Math\.max\((?:75|80|85|93),\s*parseFloat\(process\.env\.ICT_EXECUTION_MIN_CONFIDENCE \|\| '(?:75|80|85|93)'\)\)/,
      "minConfidence: Math.max(75, parseFloat(process.env.ICT_EXECUTION_MIN_CONFIDENCE || '75'))",
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
    [
      'minConfidence: 75,',
      "Math.max(75, parseFloat(process.env.ICT_EXECUTION_MIN_CONFIDENCE || '75'))",
    ],
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
