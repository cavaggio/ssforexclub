import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function writeIfChanged(relativePath, next) {
  const path = resolve(ROOT, relativePath);
  const before = readFileSync(path, 'utf8');
  if (next !== before) writeFileSync(path, next, 'utf8');
  console.log(`[DAILY_ICT_POLICY] verified ${relativePath}${next !== before ? ' (patched)' : ''}`);
}

const watchlistSource = `/**
 * ICT scanner watchlist configuration.
 *
 * The ICT engine now trades and studies exactly four pairs. Stale environment
 * variables are intentionally prevented from silently reintroducing the prior
 * broader universe.
 */

export const DEFAULT_ICT_WATCHLIST = Object.freeze([
  'EUR_USD',
  'GBP_USD',
  'USD_JPY',
  'GBP_JPY',
]);

export function configuredIctWatchlist() {
  return [...DEFAULT_ICT_WATCHLIST];
}
`;
writeIfChanged('server/ictWatchlist.js', watchlistSource);

const autoPath = resolve(ROOT, 'server/ictAutoTrade.js');
const autoBefore = readFileSync(autoPath, 'utf8');
let auto = autoBefore;

if (!auto.includes("from './dailyMarketStudy.js'")) {
  auto = auto.replace(
    "import { executeIctTrade } from './ictExecution.js';",
    "import { executeIctTrade } from './ictExecution.js';\nimport { applyStoredStudyCalibration, runDailyMarketStudy } from './dailyMarketStudy.js';",
  );
}

if (!auto.includes('executionAllowed = true')) {
  auto = auto.replace(
    "export async function runAutoAiForUser({ client, now = new Date(), runId = null, scanMode = 'full', pairs = null } = {}) {",
    "export async function runAutoAiForUser({ client, now = new Date(), runId = null, scanMode = 'full', pairs = null, executionAllowed = true, executionBlockedReason = null } = {}) {",
  );
}

if (!auto.includes("runDailyMarketStudy({ client, engine: 'ict'")) {
  const scanCall = /  const \{ analyses \} = await analyzeICTPairs\(scanPairs, \{ client, now, scanMode \}\);\n/;
  if (!scanCall.test(auto)) throw new Error('ICT generated scan-call marker missing');
  auto = auto.replace(
    scanCall,
    "  if (scanMode === 'daily_study') {\n    return runDailyMarketStudy({ client, engine: 'ict', pairs: scanPairs, now });\n  }\n\n  const { analyses: rawAnalyses } = await analyzeICTPairs(scanPairs, { client, now, scanMode });\n  const analyses = await Promise.all(rawAnalyses.map((item) =>\n    applyStoredStudyCalibration(item, { client, engine: 'ict' })\n  ));\n",
  );
}

auto = auto.replaceAll(
  "executionBlockedReason || 'scan_only_until_02:15_ET_no_new_orders'",
  "executionBlockedReason || 'ICT scan-only window: new orders are not allowed yet'",
);

for (const marker of [
  "from './dailyMarketStudy.js'",
  "runDailyMarketStudy({ client, engine: 'ict'",
  "applyStoredStudyCalibration(item, { client, engine: 'ict' })",
  'executionAllowed = true',
  'ICT scan-only window',
]) {
  if (!auto.includes(marker)) throw new Error(`ICT daily policy incomplete: missing ${marker}`);
}

if (auto !== autoBefore) writeFileSync(autoPath, auto, 'utf8');
console.log(`[DAILY_ICT_POLICY] verified server/ictAutoTrade.js${auto !== autoBefore ? ' (patched)' : ''}`);

const executionPath = resolve(ROOT, 'server/ictExecution.js');
const executionBefore = readFileSync(executionPath, 'utf8');
let execution = executionBefore;

if (!execution.includes("from './dailyMarketStudy.js'")) {
  execution = execution.replace(
    "import { analyzeICTPair, ictExecConfig } from './ictEngine.js';",
    "import { analyzeICTPair, ictExecConfig } from './ictEngine.js';\nimport { applyStoredStudyCalibration } from './dailyMarketStudy.js';",
  );
}

if (!execution.includes('markTradeOpened,')) {
  execution = execution.replace(
    /(  checkAutoExecutionConfidence,\n)(  riskConfig,\n)?\} from '\.\/riskManager\.js';/,
    (_match, confidenceLine, riskConfigLine = '') => `${confidenceLine}  markTradeOpened,\n${riskConfigLine}} from './riskManager.js';`,
  );
}

if (!execution.includes("applyStoredStudyCalibration(await analyze(pair), { client, engine: 'ict' })")) {
  execution = execution.replace(
    "  try { analysis = await analyze(pair); } catch (err) { return blocked(`ICT recompute failed: ${err.message}`); }",
    "  try {\n    analysis = await applyStoredStudyCalibration(await analyze(pair), { client, engine: 'ict' });\n  } catch (err) { return blocked(`ICT recompute failed: ${err.message}`); }",
  );
}

if (!execution.includes('markTradeOpened({ accountId, balanceUSD, now });')) {
  execution = execution.replace(
    "  registerTradeLock(pair, direction);\n  const tradeId = fill.tradeOpened?.tradeID || fill.id || fill.tradeID || null;",
    "  registerTradeLock(pair, direction);\n  markTradeOpened({ accountId, balanceUSD, now });\n  const tradeId = fill.tradeOpened?.tradeID || fill.id || fill.tradeID || null;",
  );
}

for (const marker of [
  "from './dailyMarketStudy.js'",
  'markTradeOpened,',
  "applyStoredStudyCalibration(await analyze(pair), { client, engine: 'ict' })",
  'markTradeOpened({ accountId, balanceUSD, now });',
]) {
  if (!execution.includes(marker)) throw new Error(`ICT execution daily policy incomplete: missing ${marker}`);
}

if (execution !== executionBefore) writeFileSync(executionPath, execution, 'utf8');
console.log(`[DAILY_ICT_POLICY] verified server/ictExecution.js${execution !== executionBefore ? ' (patched)' : ''}`);
