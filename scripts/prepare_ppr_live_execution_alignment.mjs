import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PATH = resolve(ROOT, 'server/oandaTrade.js');
const before = readFileSync(PATH, 'utf8');

// The legacy PPR alignment pass owns the initial riskConfig insertion and
// expects its historical import shape. Remove only the later daily-policy
// markTradeOpened import before that pass; apply_daily_bot_policy.mjs restores
// it after every legacy generator has finished. The call site may remain while
// generators run because source is not imported until the full pipeline ends.
const after = before.replace(
  "  checkAutoExecutionConfidence,\n  markTradeOpened,\n  riskConfig,\n} from './riskManager.js';",
  "  checkAutoExecutionConfidence,\n  riskConfig,\n} from './riskManager.js';",
);

if (!after.includes("  checkAutoExecutionConfidence,\n  riskConfig,\n} from './riskManager.js';")) {
  throw new Error('Could not normalize the shared executor riskManager import for PPR alignment');
}

if (after !== before) writeFileSync(PATH, after, 'utf8');
console.log(`[PPR_ALIGNMENT_PREP] shared executor import normalized${after !== before ? ' (patched)' : ''}`);
