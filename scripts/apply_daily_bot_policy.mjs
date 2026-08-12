import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function patchFile(relativePath, patcher, requiredMarkers = []) {
  const path = resolve(ROOT, relativePath);
  const before = readFileSync(path, 'utf8');
  const after = patcher(before);
  const missing = requiredMarkers.filter((marker) => (
    Array.isArray(marker)
      ? !marker.some((alternative) => after.includes(alternative))
      : !after.includes(marker)
  ));
  if (missing.length) {
    const labels = missing.map((marker) => Array.isArray(marker) ? marker.join(' OR ') : marker);
    throw new Error(`${relativePath} missing daily bot policy markers: ${labels.join(', ')}`);
  }
  if (after !== before) writeFileSync(path, after, 'utf8');
  console.log(`[DAILY_BOT_POLICY] verified ${relativePath}${after !== before ? ' (patched)' : ''}`);
}

patchFile(
  'server/pprAutoTrade.js',
  (source) => {
    let out = source;
    if (!out.includes("from './dailyMarketStudy.js'")) {
      out = out.replace(
        "import { pprRuntimeConfig } from './pprEnv.js';",
        "import { pprRuntimeConfig } from './pprEnv.js';\nimport { applyStoredStudyCalibration, runDailyMarketStudy } from './dailyMarketStudy.js';",
      );
    }
    if (!out.includes('executionAllowed = true')) {
      out = out.replace(
        "  manualExecution = false,\n} = {}) {",
        "  manualExecution = false,\n  executionAllowed = true,\n  executionBlockedReason = null,\n} = {}) {",
      );
    }
    if (!out.includes("scanMode === 'daily_study'")) {
      out = out.replace(
        "  if (!runtime.engineActive) {",
        "  if (scanMode === 'daily_study') {\n    return runDailyMarketStudy({ client, engine: 'ppr', pairs, now });\n  }\n\n  if (!runtime.engineActive) {",
      );
    }
    if (!out.includes('const rawScan = await scanPprMarket')) {
      out = out.replace(
        "  const scan = await scanPprMarket({ pairs: scanPairs, client, now, log });\n  const qualified = Array.isArray(scan?.qualified) ? scan.qualified : [];",
        "  const rawScan = await scanPprMarket({ pairs: scanPairs, client, now, log });\n  const scan = {\n    ...rawScan,\n    qualified: await Promise.all((Array.isArray(rawScan?.qualified) ? rawScan.qualified : []).map((item) =>\n      applyStoredStudyCalibration(item, { client, engine: 'ppr' })\n    )),\n    watchCandidates: await Promise.all((Array.isArray(rawScan?.watchCandidates) ? rawScan.watchCandidates : []).map((item) =>\n      applyStoredStudyCalibration(item, { client, engine: 'ppr' })\n    )),\n  };\n  const qualified = Array.isArray(scan?.qualified) ? scan.qualified : [];",
      );
    }
    if (!out.includes('PPR scan-only window')) {
      out = out.replace(
        "  if (!runtime.aiAutoExecutionEnabled) {",
        "  if (!executionAllowed) {\n    const reason = executionBlockedReason || 'PPR scan-only window: new orders are not allowed yet';\n    const skipped = qualified.map((candidate) => ({\n      pair: candidate.pair, direction: candidate.direction, reason,\n    }));\n    log(`PPR scan-only window qualified=${qualified.length} executed=0 reason=\"${reason}\"`);\n    return {\n      engine: 'ppr',\n      architecture: 'independent_ppr_raw_market_data',\n      legacyScannerUsed: false,\n      v3LogicUsed: false,\n      ictLogicUsed: false,\n      scanned: counts.scanned,\n      qualified: qualified.length,\n      watching: counts.watchCount,\n      rejectedCount: counts.rejectedCount,\n      accountedFor: counts.accountedFor,\n      countInvariantOk: counts.countInvariantOk,\n      executionReadiness: counts.executionReadiness,\n      executed: [],\n      skipped,\n      watchCandidates: scan?.watchCandidates || [],\n      rejected: scan?.rejected || [],\n      pprRuntime: runtime,\n      autoManageEnabled: runtime.aiAutoManageEnabled,\n      ...watchState,\n    };\n  }\n\n  if (!runtime.aiAutoExecutionEnabled) {",
      );
    }
    return out.replaceAll('riskPercent: 1.25', 'riskPercent: 1');
  },
  [
    "runDailyMarketStudy({ client, engine: 'ppr', pairs, now })",
    "applyStoredStudyCalibration(item, { client, engine: 'ppr' })",
    'PPR scan-only window',
    'executionAllowed = true',
    'riskPercent: 1',
  ],
);

patchFile(
  'server/pprExecution.js',
  (source) => {
    let out = source;
    if (!out.includes("from './dailyMarketStudy.js'")) {
      out = out.replace(
        "import { pprRuntimeConfig } from './pprEnv.js';",
        "import { pprRuntimeConfig } from './pprEnv.js';\nimport { applyStoredStudyCalibration } from './dailyMarketStudy.js';",
      );
    }
    if (!out.includes('const studiedSignal = await applyStoredStudyCalibration')) {
      out = out.replace(
        "  if (fresh.signal.direction !== originalDirection) {\n    return { allowed: false, reason: `PPR direction changed from ${originalDirection} to ${fresh.signal.direction}`, fresh, runtime };\n  }\n\n  const config = pprConfig();\n  const policy = evaluatePprExecutionPolicy(fresh.signal, {",
        "  const studiedSignal = await applyStoredStudyCalibration(fresh.signal, { client, engine: 'ppr' });\n  if (studiedSignal.direction !== originalDirection) {\n    return { allowed: false, reason: `PPR direction changed from ${originalDirection} to ${studiedSignal.direction}`, fresh, runtime };\n  }\n\n  const config = pprConfig();\n  if (!(Number(studiedSignal.confidence) >= config.minConfidence)) {\n    return {\n      allowed: false,\n      reason: `PPR confidence below threshold after daily-study calibration (${studiedSignal.confidence} < ${config.minConfidence})`,\n      fresh,\n      studiedSignal,\n      runtime,\n    };\n  }\n  const policy = evaluatePprExecutionPolicy(studiedSignal, {",
      );
      out = out.replace(
        "  return { allowed: true, signal: fresh.signal, policy, runtime };",
        "  return { allowed: true, signal: studiedSignal, policy, runtime };",
      );
    }
    return out.replaceAll('riskPercent: 1.25', 'riskPercent: 1');
  },
  [
    "applyStoredStudyCalibration(fresh.signal, { client, engine: 'ppr' })",
    'PPR confidence below threshold after daily-study calibration',
    'signal: studiedSignal',
    'riskPercent: 1',
  ],
);

patchFile(
  'server/ictAutoTrade.js',
  (source) => {
    let out = source;
    if (!out.includes("from './dailyMarketStudy.js'")) {
      out = out.replace(
        "import { executeIctTrade } from './ictExecution.js';",
        "import { executeIctTrade } from './ictExecution.js';\nimport { applyStoredStudyCalibration, runDailyMarketStudy } from './dailyMarketStudy.js';",
      );
    }
    if (!out.includes('executionAllowed = true')) {
      out = out.replace(
        "export async function runAutoAiForUser({ client, now = new Date(), runId = null, scanMode = 'full', pairs = null } = {}) {",
        "export async function runAutoAiForUser({ client, now = new Date(), runId = null, scanMode = 'full', pairs = null, executionAllowed = true, executionBlockedReason = null } = {}) {",
      );
    }
    if (!out.includes("runDailyMarketStudy({ client, engine: 'ict'")) {
      out = out.replace(
        "  log(`scan started scanMode=${scanMode} pairs=${scanPairs?.length ? scanPairs.join(',') : 'ALL'}`);\n\n  const { analyses } = await analyzeICTPairs(scanPairs, { client, now, scanMode });\n  const qualified = analyses.filter((a) => a.signal !== 'none' && a.confidence >= cfg.minConfidence);",
        "  log(`scan started scanMode=${scanMode} pairs=${scanPairs?.length ? scanPairs.join(',') : 'ALL'}`);\n\n  if (scanMode === 'daily_study') {\n    return runDailyMarketStudy({ client, engine: 'ict', pairs: scanPairs, now });\n  }\n\n  const { analyses: rawAnalyses } = await analyzeICTPairs(scanPairs, { client, now, scanMode });\n  const analyses = await Promise.all(rawAnalyses.map((item) =>\n    applyStoredStudyCalibration(item, { client, engine: 'ict' })\n  ));\n  const qualified = analyses.filter((a) => a.signal !== 'none' && a.confidence >= cfg.minConfidence);",
      );
    }
    if (!out.includes('ICT scan-only window')) {
      out = out.replace(
        "  const executed = [];\n  const skipped = [];",
        "  if (!executionAllowed) {\n    const reason = executionBlockedReason || 'ICT scan-only window: new orders are not allowed yet';\n    const skipped = qualified.map((candidate) => ({ pair: candidate.pair, reason }));\n    log(`ICT scan-only window qualified=${qualified.length} executed=0 reason=\"${reason}\"`);\n    return { scanned: analyses.length, qualified: qualified.length, executed: [], skipped, ...watchState };\n  }\n\n  const executed = [];\n  const skipped = [];",
      );
    }
    return out;
  },
  [
    "runDailyMarketStudy({ client, engine: 'ict'",
    "applyStoredStudyCalibration(item, { client, engine: 'ict' })",
    'ICT scan-only window',
    'executionAllowed = true',
  ],
);

patchFile(
  'server/v3AutoTrade.js',
  (source) => {
    let out = source;
    if (!out.includes('executionAllowed = true')) {
      out = out.replace(
        "  pairs = null,\n} = {}) {",
        "  pairs = null,\n  executionAllowed = true,\n  executionBlockedReason = null,\n} = {}) {",
      );
    }
    if (!out.includes('V3 scan-only window')) {
      out = out.replace(
        "  const executed = [];\n  const skipped = [];",
        "  if (!executionAllowed) {\n    const reason = executionBlockedReason || 'V3 scan-only window: new orders are not allowed yet';\n    const skipped = qualified.map((candidate) => ({\n      pair: candidate.pair, direction: candidate.direction, reason,\n    }));\n    log(`V3 scan-only window qualified=${qualified.length} executed=0 reason=\"${reason}\"`);\n    return {\n      engine: 'v3',\n      architecture: 'independent_v3_raw_market_data',\n      scanned: scan?.meta?.pairsScanned ?? qualified.length,\n      qualified: qualified.length,\n      executed: [],\n      skipped,\n      v3Promoted: qualified.length,\n      independentV3Qualified: qualified.length,\n      qualityWatch: stageWatchCandidates.length,\n      watchCandidates: stageWatchCandidates,\n      ...watchState,\n    };\n  }\n\n  const executed = [];\n  const skipped = [];",
      );
    }
    return out;
  },
  ['executionAllowed = true', 'V3 scan-only window'],
);

patchFile(
  'server/ictExecution.js',
  (source) => {
    let out = source;
    if (!out.includes("from './dailyMarketStudy.js'")) {
      out = out.replace(
        "import { analyzeICTPair, ictExecConfig } from './ictEngine.js';",
        "import { analyzeICTPair, ictExecConfig } from './ictEngine.js';\nimport { applyStoredStudyCalibration } from './dailyMarketStudy.js';",
      );
    }
    if (!out.includes('markTradeOpened,')) {
      out = out.replace(
        "  reserveDailyLossBudget,\n  checkAutoExecutionConfidence,\n} from './riskManager.js';",
        "  reserveDailyLossBudget,\n  checkAutoExecutionConfidence,\n  markTradeOpened,\n} from './riskManager.js';",
      );
    }
    if (
      !out.includes("applyStoredStudyCalibration(await analyze(pair), { client, engine: 'ict' })") &&
      !out.includes("applyStoredStudyCalibration(rawAnalysis, { client, engine: 'ict' })")
    ) {
      out = out.replace(
        "  try { analysis = await analyze(pair); } catch (err) { return blocked(`ICT recompute failed: ${err.message}`); }",
        "  try {\n    analysis = await applyStoredStudyCalibration(await analyze(pair), { client, engine: 'ict' });\n  } catch (err) { return blocked(`ICT recompute failed: ${err.message}`); }",
      );
    }
    if (!out.includes('markTradeOpened({ accountId, balanceUSD, now });')) {
      out = out.replace(
        "  registerTradeLock(pair, direction);\n  const tradeId = fill.tradeOpened?.tradeID || fill.id || fill.tradeID || null;",
        "  registerTradeLock(pair, direction);\n  markTradeOpened({ accountId, balanceUSD, now });\n  const tradeId = fill.tradeOpened?.tradeID || fill.id || fill.tradeID || null;",
      );
    }
    return out;
  },
  [
    [
      "applyStoredStudyCalibration(await analyze(pair), { client, engine: 'ict' })",
      "applyStoredStudyCalibration(rawAnalysis, { client, engine: 'ict' })",
    ],
    'markTradeOpened,',
    'markTradeOpened({ accountId, balanceUSD, now });',
  ],
);

patchFile(
  'server/oandaTrade.js',
  (source) => {
    let out = source;
    if (!out.includes('markTradeOpened,')) {
      out = out.replace(
        "  checkAutoExecutionConfidence,\n  riskConfig,\n} from './riskManager.js';",
        "  checkAutoExecutionConfidence,\n  markTradeOpened,\n  riskConfig,\n} from './riskManager.js';",
      );
    }
    if (!out.includes('markTradeOpened({ accountId, balanceUSD });')) {
      out = out.replace(
        "  activeTrades.add(tradeKey);\n\n  let effectiveTpPrice = tpPrice;",
        "  activeTrades.add(tradeKey);\n  markTradeOpened({ accountId, balanceUSD });\n\n  let effectiveTpPrice = tpPrice;",
      );
    }
    return out;
  },
  ['markTradeOpened,', 'markTradeOpened({ accountId, balanceUSD });'],
);

patchFile(
  'server/index.js',
  (source) => source.replaceAll(
    "['full', 'near_recheck', 'hot_watch']",
    "['full', 'near_recheck', 'hot_watch', 'daily_study']",
  ),
  ["['full', 'near_recheck', 'hot_watch', 'daily_study']"],
);

patchFile(
  'server/ictAutoScheduler.js',
  (source) => {
    let out = source;
    if (!out.includes('DAILY_MARKET_STUDY_WINDOW')) {
      out = out.replace(
        "export const ACTIVE_TRADE_MANAGEMENT_WINDOW = { startMin: 600, endMin: 1050 }; // 10:00–17:30 ET",
        "export const ACTIVE_TRADE_MANAGEMENT_WINDOW = { startMin: 600, endMin: 1050 }; // 10:00–17:30 ET\nexport const DAILY_MARKET_STUDY_WINDOW = { startMin: 1020, endMin: 1035 }; // 17:00–17:15 ET",
      );
    }
    if (!out.includes('DAILY_MARKET_STUDY_INTERVAL_MS')) {
      out = out.replace(
        "export const OANDA_TRANSACTION_SYNC_INTERVAL_MS = interval('OANDA_TRANSACTION_SYNC_INTERVAL_MS', 1800000);",
        "export const OANDA_TRANSACTION_SYNC_INTERVAL_MS = interval('OANDA_TRANSACTION_SYNC_INTERVAL_MS', 1800000);\nexport const DAILY_MARKET_STUDY_INTERVAL_MS = interval('DAILY_MARKET_STUDY_INTERVAL_MS', 300000);",
      );
    }
    if (!out.includes('let lastDailyStudyDateKey')) {
      out = out.replace('let timers = [];', 'let timers = [];\nlet lastDailyStudyDateKey = null;');
    }
    if (!out.includes('inDailyMarketStudyWindow')) {
      out = out.replace(
        "export function inActiveTradeManagementWindow(date = new Date()) { return inWindow(date, ACTIVE_TRADE_MANAGEMENT_WINDOW); }",
        "export function inActiveTradeManagementWindow(date = new Date()) { return inWindow(date, ACTIVE_TRADE_MANAGEMENT_WINDOW); }\nexport function inDailyMarketStudyWindow(date = new Date()) { return inWindow(date, DAILY_MARKET_STUDY_WINDOW); }",
      );
    }
    out = out.replace(
      '`[AUTO_AI] scans=02:00–10:00_ET entries=02:15–10:00_ET weekdays_only ` +',
      '`[AUTO_AI] scans=02:00–10:00_ET entries=V3_02:15/PPR_03:00/ICT_05:00 weekdays_only ` +',
    );
    if (!out.includes('DAILY_MARKET_STUDY_INTERVAL_MS));')) {
      out = out.replace(
        "  addTimer(setInterval(() => void transactionSyncTick(nextUrl, secret), OANDA_TRANSACTION_SYNC_INTERVAL_MS));",
        "  addTimer(setInterval(() => void transactionSyncTick(nextUrl, secret), OANDA_TRANSACTION_SYNC_INTERVAL_MS));\n  addTimer(setInterval(() => void dailyMarketStudyTick(nextUrl, secret), DAILY_MARKET_STUDY_INTERVAL_MS));",
      );
    }
    if (!out.includes('void dailyMarketStudyTick(nextUrl, secret);')) {
      out = out.replace(
        "  void transactionSyncTick(nextUrl, secret);",
        "  void transactionSyncTick(nextUrl, secret);\n  void dailyMarketStudyTick(nextUrl, secret);",
      );
    }
    if (!out.includes('dailyStudyMs: DAILY_MARKET_STUDY_INTERVAL_MS')) {
      out = out.replace(
        "    managementMs: ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS,",
        "    managementMs: ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS,\n    dailyStudyMs: DAILY_MARKET_STUDY_INTERVAL_MS,",
      );
    }
    if (!out.includes('export async function dailyMarketStudyTick')) {
      out = out.replace(
        "async function transactionSyncTick(nextUrl, secret) {\n  return post(nextUrl, secret, '/api/cron/oanda-transaction-sync', { source: 'railway-scheduler' }, '[OANDA_TX_SYNC]');\n}\n",
        "async function transactionSyncTick(nextUrl, secret) {\n  return post(nextUrl, secret, '/api/cron/oanda-transaction-sync', { source: 'railway-scheduler' }, '[OANDA_TX_SYNC]');\n}\n\nfunction newYorkDateKey(date = new Date()) {\n  return new Intl.DateTimeFormat('en-CA', {\n    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',\n  }).format(date);\n}\n\nexport async function dailyMarketStudyTick(nextUrl, secret, now = new Date()) {\n  if (!inDailyMarketStudyWindow(now)) {\n    return { ok: true, skipped: true, reason: 'outside_daily_market_study_window' };\n  }\n  const dayKey = newYorkDateKey(now);\n  if (lastDailyStudyDateKey === dayKey) {\n    return { ok: true, skipped: true, reason: 'daily_market_study_already_completed', dayKey };\n  }\n  const results = [];\n  for (const engine of ['ict', 'ppr']) {\n    const runId = makeRunId();\n    results.push(await post(nextUrl, secret, '/api/cron/auto-ai-trading-extended', {\n      source: 'railway-scheduler', runId, scanMode: 'daily_study', pairs: [], engine,\n    }, `[DAILY_STUDY][${engine.toUpperCase()}][runId=${runId}]`));\n  }\n  const ok = results.every((result) => result.ok);\n  if (ok) lastDailyStudyDateKey = dayKey;\n  return { ok, dayKey, results };\n}\n",
      );
    }
    if (!out.includes('lastDailyStudyDateKey = null;')) {
      out = out.replace(
        "  timers = [];\n  for (const engine of AUTO_ENGINES) clearEngineWatchState(engine);",
        "  timers = [];\n  lastDailyStudyDateKey = null;\n  for (const engine of AUTO_ENGINES) clearEngineWatchState(engine);",
      );
    }
    return out;
  },
  [
    'DAILY_MARKET_STUDY_WINDOW',
    'DAILY_MARKET_STUDY_INTERVAL_MS',
    'inDailyMarketStudyWindow',
    'export async function dailyMarketStudyTick',
    "scanMode: 'daily_study'",
    [
      'entries=V3_02:15/PPR_03:00/ICT_05:00',
      'entries=V3/PPR/ICT_02:15',
    ],
  ],
);

console.log('[DAILY_BOT_POLICY] all daily timing, study, and risk integrations verified');
