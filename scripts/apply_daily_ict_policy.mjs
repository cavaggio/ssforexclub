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
 * The four FX pairs remain eligible for the existing OANDA execution path.
 * Gold and the two US index instruments are signal-only: the ICT Intelligence
 * tab analyses them from an independent market-data feed, but the OANDA
 * executor and Auto AI must never submit orders for them.
 */

export const ICT_EXECUTABLE_WATCHLIST = Object.freeze([
  'EUR_USD',
  'GBP_USD',
  'USD_JPY',
  'GBP_JPY',
]);

export const ICT_ANALYSIS_ONLY_WATCHLIST = Object.freeze([
  'XAU_USD',
  'US30_USD',
  'SPX500_USD',
]);

export const DEFAULT_ICT_WATCHLIST = Object.freeze([
  ...ICT_EXECUTABLE_WATCHLIST,
  ...ICT_ANALYSIS_ONLY_WATCHLIST,
]);

export function configuredIctWatchlist() {
  return [...DEFAULT_ICT_WATCHLIST];
}

export function isIctAnalysisOnlyInstrument(instrument) {
  return ICT_ANALYSIS_ONLY_WATCHLIST.includes(String(instrument || '').trim().toUpperCase());
}

export function isIctExecutionEligibleInstrument(instrument) {
  return ICT_EXECUTABLE_WATCHLIST.includes(String(instrument || '').trim().toUpperCase());
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

if (!execution.includes('hydrateDailyRiskState,')) {
  execution = execution.replace(
    '  checkDailyRiskLock,\n',
    '  checkDailyRiskLock,\n  hydrateDailyRiskState,\n  persistDailyRiskState,\n',
  );
}

if (
  !execution.includes("applyStoredStudyCalibration(await analyze(pair), { client, engine: 'ict' })") &&
  !execution.includes("applyStoredStudyCalibration(rawAnalysis, { client, engine: 'ict' })")
) {
  execution = execution.replace(
    "  try { analysis = await analyze(pair); } catch (err) { return blocked(`ICT recompute failed: ${err.message}`); }",
    "  try {\n    analysis = await applyStoredStudyCalibration(await analyze(pair), { client, engine: 'ict' });\n  } catch (err) { return blocked(`ICT recompute failed: ${err.message}`); }",
  );
}

if (!execution.includes('await hydrateDailyRiskState({ accountId: riskAccountId, balanceUSD, now });')) {
  execution = execution.replace(
    "  if (!balanceUSD || Number.isNaN(balanceUSD)) return blocked('Account balance is 0 — fund account before live trading.');\n\n  // ── 8a. Daily drawdown circuit breaker",
    "  if (!balanceUSD || Number.isNaN(balanceUSD)) return blocked('Account balance is 0 — fund account before live trading.');\n  const riskAccountId =\n    client?.accountId || client?.accountID || client?.account_id ||\n    client?.config?.accountId || client?.defaults?.accountId;\n  await hydrateDailyRiskState({ accountId: riskAccountId, balanceUSD, now });\n\n  // ── 8a. Daily drawdown circuit breaker",
  );
}

execution = execution
  .replace('checkDailyRiskLock({ accountId: client.accountId, balanceUSD, now })', 'checkDailyRiskLock({ accountId: riskAccountId, balanceUSD, now })')
  .replace('reserveDailyLossBudget({ accountId: client.accountId, balanceUSD,', 'reserveDailyLossBudget({ accountId: riskAccountId, balanceUSD,');

if (!execution.includes('await persistDailyRiskState({ accountId, balanceUSD, now });')) {
  execution = execution.replace(
    '  markTradeOpened({ accountId, balanceUSD, now });\n',
    '  markTradeOpened({ accountId, balanceUSD, now });\n  await persistDailyRiskState({ accountId, balanceUSD, now });\n',
  );
}

for (const marker of [
  "from './dailyMarketStudy.js'",
  'markTradeOpened,',
  'hydrateDailyRiskState,',
  'persistDailyRiskState,',
  'await hydrateDailyRiskState({ accountId: riskAccountId, balanceUSD, now });',
  'markTradeOpened({ accountId, balanceUSD, now });',
  'await persistDailyRiskState({ accountId, balanceUSD, now });',
]) {
  if (!execution.includes(marker)) throw new Error(`ICT execution daily policy incomplete: missing ${marker}`);
}
if (
  !execution.includes("applyStoredStudyCalibration(await analyze(pair), { client, engine: 'ict' })") &&
  !execution.includes("applyStoredStudyCalibration(rawAnalysis, { client, engine: 'ict' })")
) {
  throw new Error('ICT execution daily policy incomplete: missing stored-study calibration');
}

if (execution !== executionBefore) writeFileSync(executionPath, execution, 'utf8');
console.log(`[DAILY_ICT_POLICY] verified server/ictExecution.js${execution !== executionBefore ? ' (patched)' : ''}`);
