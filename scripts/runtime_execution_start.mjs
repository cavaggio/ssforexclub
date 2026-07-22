import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyIctRrFloorRuntime } from './apply_ict_rr_floor_runtime.mjs';

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

    if (!out.includes('riskConfig,')) {
      out = out.replace(
        "  checkAutoExecutionConfidence,\n} from './riskManager.js';",
        "  checkAutoExecutionConfidence,\n  riskConfig,\n} from './riskManager.js';",
      );
    }

    out = out.replace(
      /const confCheck = checkAutoExecutionConfidence\(analysis\.confidence\);\n\s*if \(!confCheck\.passed\) return blocked\(confCheck\.reason\);/,
      "const confCheck = checkAutoExecutionConfidence(analysis.confidence, {\n      ...riskConfig(),\n      autoExecutionMinConfidence: config.minConfidence,\n    });\n    if (!confCheck.passed) return blocked(confCheck.reason);",
    );

    return out;
  },
  [
    "config.mode === 'active' || config.mode === 'live'",
    'riskConfig,',
    'autoExecutionMinConfidence: config.minConfidence',
    'stopLossOnFill',
    'takeProfitOnFill',
  ],
);

patchFile(
  'server/index.js',
  (source) => {
    let out = source.replace(
      "import { analyzeICTPairs, ICT_MODE } from './ictEngine.js';",
      "import { analyzeICTPairs, ICT_MODE, ictExecConfig, isIctExecutionEnabled } from './ictEngine.js';",
    );

    out = out.replace(
      /  \/\/ ICT engine is shadow-only analysis \(never trades\); 'off' disables the tab's data\.\n  const ictExecutionEnabled =\n    process\.env\.ICT_ENGINE_MODE === 'live' &&\n    process\.env\.ICT_AUTO_TRADE_ENABLED === 'true';\n\n  console\.log\(\n    `\[ICT\] mode=\$\{process\.env\.ICT_ENGINE_MODE \|\| 'shadow'\} ` \+\n    `autoTrade=\$\{process\.env\.ICT_AUTO_TRADE_ENABLED === 'true'\} ` \+\n    `executionEnabled=\$\{ictExecutionEnabled\} ` \+\n    `minConfidence=\$\{process\.env\.ICT_MIN_CONFIDENCE \|\| 80\} ` \+\n    `minRR=\$\{process\.env\.ICT_MIN_RR \|\| 2\.0\} ` \+\n    `maxRiskPercent=\$\{process\.env\.ICT_MAX_RISK_PERCENT \|\| 1\} ` \+\n    `signalTtlSec=\$\{process\.env\.ICT_SIGNAL_TTL_SEC \|\| 300\}`\n  \);/,
      "  // Log the same authoritative execution contract used by the ICT executor.\n  const ictConfig = ictExecConfig();\n  const ictExecutionEnabled = isIctExecutionEnabled();\n\n  console.log(\n    `[ICT] mode=${ictConfig.mode} ` +\n    `autoTrade=${ictConfig.autoTradeEnabled} ` +\n    `executionEnabled=${ictExecutionEnabled} ` +\n    `minConfidence=${ictConfig.minConfidence} ` +\n    `minRR=${ictConfig.minRR} ` +\n    `maxRiskPercent=${ictConfig.maxRiskPercent} ` +\n    `signalTtlSec=${ictConfig.signalTtlSec}`\n  );",
    );

    return out;
  },
  [
    'ictExecConfig, isIctExecutionEnabled',
    'const ictConfig = ictExecConfig();',
    'const ictExecutionEnabled = isIctExecutionEnabled();',
    'minRR=${ictConfig.minRR}',
  ],
);

const requiredTruthy = [
  'FOREX_AUTO_TRADE_ENABLED',
  'ICT_AUTO_TRADE_ENABLED',
  'ICT_AUTO_AI_SCHEDULER_ENABLED',
  'PPR_AI_AUTO_EXECUTION_ENABLED',
];
for (const name of requiredTruthy) {
  if (!truthy(process.env[name])) {
    throw new Error(`${name} must be enabled before the trading server starts`);
  }
}

const ictModule = await import('../server/ictEngine.js');
const verifiedIctConfig = ictModule.ictExecConfig();
if (!ictModule.isIctExecutionEnabled()) {
  throw new Error(
    `ICT execution contract failed after runtime patch: mode=${verifiedIctConfig.mode} ` +
    `autoTrade=${verifiedIctConfig.autoTradeEnabled}`,
  );
}
if (verifiedIctConfig.minConfidence < 80 || verifiedIctConfig.minRR < 1.5 || verifiedIctConfig.maxRiskPercent > 1.25) {
  throw new Error(`ICT runtime thresholds are unsafe or misaligned: ${JSON.stringify(verifiedIctConfig)}`);
}

console.log(
  `[RUNTIME_EXECUTION_START] READY ictMode=${verifiedIctConfig.mode} ` +
  `ictExecutionEnabled=true minConfidence=${verifiedIctConfig.minConfidence} ` +
  `minRR=${verifiedIctConfig.minRR} maxRiskPercent=${verifiedIctConfig.maxRiskPercent} ` +
  `v3Mode=${process.env.FOREX_V3_ENGINE_MODE || 'off'} pprMode=${process.env.PPR_ENGINE_MODE || 'active'}`,
);

await import('../server/index.js');
