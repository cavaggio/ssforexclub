import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyIctRrFloorRuntime } from './apply_ict_rr_floor_runtime.mjs';
import { applyManualTargetRiskRuntime } from './apply_manual_target_risk_runtime.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled', 'active']);

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
  process.env.ICT_MIN_CONFIDENCE = String(Math.max(80, finiteNumber(process.env.ICT_MIN_CONFIDENCE, 80)));
  process.env.ICT_MIN_RR = String(Math.max(1.5, finiteNumber(process.env.ICT_MIN_RR, 1.5)));
  process.env.ICT_MAX_RISK_PERCENT = String(Math.min(1.25, Math.max(0.01, finiteNumber(process.env.ICT_MAX_RISK_PERCENT, 1.25))));
  process.env.RISK_MAX_PER_TRADE_PERCENT = String(Math.min(1.25, Math.max(0.01, finiteNumber(process.env.RISK_MAX_PER_TRADE_PERCENT, 1.25))));
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
applyIctRrFloorRuntime();

// Manual target-risk propagation is a compatibility patch, not a prerequisite
// for starting the API. A stale source marker must never take the entire scanner,
// active-trade monitor, reassessor, and calibration endpoints offline. The
// execution modules still enforce the central 1.25% risk cap independently.
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
      /minConfidence:\s*Math\.max\((?:80|85),\s*parseFloat\(process\.env\.ICT_MIN_CONFIDENCE \|\| '(?:80|85)'\)\)/,
      "minConfidence: Math.max(80, parseFloat(process.env.ICT_MIN_CONFIDENCE || '80'))",
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
    "Math.max(80, parseFloat(process.env.ICT_MIN_CONFIDENCE || '80'))",
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
