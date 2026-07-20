import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

patchFile(
  'server/ictEngine.js',
  (source) => source
    .replace(
      "export function isIctEnabled() { return ICT_MODE === 'shadow' || ICT_MODE === 'live'; }",
      "export function isIctEnabled() { return ICT_MODE === 'shadow' || ICT_MODE === 'active' || ICT_MODE === 'live'; }",
    )
    .replace(
      "minConfidence: Math.max(85, parseFloat(process.env.ICT_MIN_CONFIDENCE || '85'))",
      "minConfidence: Math.max(80, parseFloat(process.env.ICT_MIN_CONFIDENCE || '80'))",
    )
    .replace(
      "minRR: parseFloat(process.env.ICT_MIN_RR || '2.0')",
      "minRR: parseFloat(process.env.ICT_MIN_RR || '1.5')",
    )
    .replace(
      "const MIN_RR = parseFloat(process.env.ICT_MIN_RR || '2.0');",
      "const MIN_RR = parseFloat(process.env.ICT_MIN_RR || '1.5');",
    )
    .replace(
      "return c.mode === 'live' && c.autoTradeEnabled === true;",
      "return (c.mode === 'active' || c.mode === 'live') && c.autoTradeEnabled === true;",
    ),
  [
    "ICT_MODE === 'active'",
    "Math.max(80, parseFloat(process.env.ICT_MIN_CONFIDENCE || '80'))",
    "parseFloat(process.env.ICT_MIN_RR || '1.5')",
    "(c.mode === 'active' || c.mode === 'live') && c.autoTradeEnabled === true",
  ],
);

patchFile(
  'server/ictExecution.js',
  (source) => {
    let out = source
      .replace(
        "if (!(config.mode === 'live' && config.autoTradeEnabled === true)) {",
        "if (!((config.mode === 'active' || config.mode === 'live') && config.autoTradeEnabled === true)) {",
      )
      .replace(
        "if (!((config.mode === 'live') && config.autoTradeEnabled === true)) {",
        "if (!((config.mode === 'active' || config.mode === 'live') && config.autoTradeEnabled === true)) {",
      );

    if (!out.includes('riskConfig,')) {
      out = out.replace(
        "  checkAutoExecutionConfidence,\n} from './riskManager.js';",
        "  checkAutoExecutionConfidence,\n  riskConfig,\n} from './riskManager.js';",
      );
    }

    out = out.replace(
      "const confCheck = checkAutoExecutionConfidence(analysis.confidence);\n    if (!confCheck.passed) return blocked(confCheck.reason);",
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

const requiredTruthy = [
  'FOREX_AUTO_TRADE_ENABLED',
  'ICT_AUTO_TRADE_ENABLED',
  'ICT_AUTO_AI_SCHEDULER_ENABLED',
  'PPR_AI_AUTO_EXECUTION_ENABLED',
];
for (const name of requiredTruthy) {
  if (!['1', 'true', 'yes', 'on', 'enabled', 'active'].includes(String(process.env[name] || '').trim().toLowerCase())) {
    throw new Error(`${name} must be enabled before the trading server starts`);
  }
}

console.log(
  `[RUNTIME_EXECUTION_START] READY ictMode=${process.env.ICT_ENGINE_MODE || 'shadow'} ` +
  `v3Mode=${process.env.FOREX_V3_ENGINE_MODE || 'off'} pprMode=${process.env.PPR_ENGINE_MODE || 'active'}`,
);

await import('../server/index.js');
