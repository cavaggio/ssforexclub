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

// run_v3_entry_contract.py still regenerates the historical reservation
// fingerprint before later compatibility passes run. Preserve the current
// Signal Stack contract: an ICT reservation is keyed to the fresh M5
// authorization/entry candle and, when available, the explicit ICT entry cycle.
// This prevents a legacy source generator from collapsing a genuinely new M5
// trigger back into an older broad setup reservation.
const EXECUTION_POLICY_PATH = resolve(ROOT, 'server/executionPolicy.js');
const policyBefore = readFileSync(EXECUTION_POLICY_PATH, 'utf8');
const legacyFingerprint = `export function setupFingerprint(signal = {}, accountId = '') {
  const v3 = extractV3(signal); const structure = v3.structure || signal.structure || {}; const liquidity = v3.liquidity || signal.liquidity || {};
  const triggerTime = firstText(signal.triggerCandleTime, signal.signalTimestamp, signal.generatedAt, structure.bos?.time, structure.choch?.time, liquidity.liquiditySweep?.time);
  const rangeHigh = firstNumber(signal.rangeHigh, signal.range?.high, structure.rangeHigh, structure.range?.high, v3.liquidity?.dealingRange?.high);
  const rangeLow = firstNumber(signal.rangeLow, signal.range?.low, structure.rangeLow, structure.range?.low, v3.liquidity?.dealingRange?.low);
  const event = firstText(liquidity.liquiditySweep?.sweptSource, liquidity.liquiditySweep?.subtype, structure.choch?.direction, structure.bos?.direction, 'none');
  return [accountId || 'default', signal.pair || signal.instrument || 'unknown', signal.direction || 'none', signal.session?.name || signal.session || 'none', rangeHigh ?? 'na', rangeLow ?? 'na', event, triggerTime || 'na'].join('|');
}`;
const currentFingerprint = `export function setupFingerprint(signal = {}, accountId = '') {
  const v3 = extractV3(signal); const structure = v3.structure || signal.structure || {}; const liquidity = v3.liquidity || signal.liquidity || {};
  const entryAuthorization = signal.entryAuthorization || {};
  const entryCandle = signal.entryCandle || {};
  // ICT reservations must rotate with the actual fresh M5 authorization rather
  // than inheriting an older broad setup hash. This preserves loss-locking for
  // the exact failed trigger while allowing a genuinely new qualified M5 setup
  // (and/or new entry cycle) to reserve normally.
  const triggerTime = firstText(
    entryCandle.time,
    entryAuthorization.triggerTime,
    signal.triggerCandleTime,
    signal.signalTimestamp,
    signal.generatedAt,
    structure.bos?.time,
    structure.choch?.time,
    liquidity.liquiditySweep?.time,
  );
  const rangeHigh = firstNumber(signal.rangeHigh, signal.range?.high, structure.rangeHigh, structure.range?.high, v3.liquidity?.dealingRange?.high);
  const rangeLow = firstNumber(signal.rangeLow, signal.range?.low, structure.rangeLow, structure.range?.low, v3.liquidity?.dealingRange?.low);
  const event = firstText(liquidity.liquiditySweep?.sweptSource, liquidity.liquiditySweep?.subtype, structure.choch?.direction, structure.bos?.direction, 'none');
  const fingerprint = [accountId || 'default', signal.pair || signal.instrument || 'unknown', signal.direction || 'none', signal.session?.name || signal.session || 'none', rangeHigh ?? 'na', rangeLow ?? 'na', event, triggerTime || 'na'];
  const ictCycleId = firstText(entryAuthorization.cycleId, signal.entryCycleId);
  if (ictCycleId) fingerprint.push(\`cycle:\${ictCycleId}\`);
  return fingerprint.join('|');
}`;

let policyAfter = policyBefore;
if (!policyAfter.includes(currentFingerprint)) {
  if (!policyAfter.includes(legacyFingerprint)) {
    throw new Error('Could not locate execution-policy fingerprint compatibility anchor');
  }
  policyAfter = policyAfter.replace(legacyFingerprint, currentFingerprint);
}
if (policyAfter !== policyBefore) writeFileSync(EXECUTION_POLICY_PATH, policyAfter, 'utf8');
console.log(`[PPR_ALIGNMENT_PREP] execution fingerprint preserved${policyAfter !== policyBefore ? ' (patched)' : ''}`);
