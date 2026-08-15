import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function replaceRequired(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`[ACCOUNT_ENGINE_ISOLATION] missing ${label}`);
  return source.replace(before, after);
}

function patchFile(root, relativePath, patcher, markers = []) {
  const path = resolve(root, relativePath);
  const before = readFileSync(path, 'utf8');
  const after = patcher(before);
  const missing = markers.filter((marker) => !after.includes(marker));
  if (missing.length) throw new Error(`${relativePath} missing account/engine isolation markers: ${missing.join(', ')}`);
  if (after !== before) writeFileSync(path, after, 'utf8');
  console.log(`[ACCOUNT_ENGINE_ISOLATION] verified ${relativePath}${after !== before ? ' (patched)' : ''}`);
}

export function applyAccountEngineIsolation(root = DEFAULT_ROOT) {
  patchFile(root, 'web/app/api/cron/auto-ai-trading-extended/route.ts', (source) => {
    let out = source;
    out = replaceRequired(
      out,
      `    const selectedEngines: AutoAiEngine[] = scanMode === 'daily_study' && engineFilter
      ? [engineFilter]
      : engineFilter
        ? [engineFilter]
        : [...AUTO_AI_ENGINES];
    const selectedEngine = selectedEngines[0] ?? configuredEngine;
    enabledEngines.add(selectedEngine);`,
      `    const selectedEngines: AutoAiEngine[] = scanMode === 'daily_study' && engineFilter
      ? [engineFilter]
      : engineFilter
        ? engineFilter === configuredEngine ? [configuredEngine] : []
        : [configuredEngine];
    if (!selectedEngines.length) {
      results.push({
        user: row.user_id,
        configuredEngine,
        requestedEngine: engineFilter,
        skipped: 'engine_scope_mismatch',
        reason: 'Targeted engine request does not match this account configured Auto AI engine.',
      });
      continue;
    }
    const selectedEngine = selectedEngines[0];
    enabledEngines.add(selectedEngine);`,
      'selected engine routing',
    );
    out = out
      .replaceAll('allEnginesActive=true', 'accountEngineIsolation=true')
      .replaceAll("executionMode: 'all_enabled_engines'", "executionMode: 'selected_engine_only'")
      .replaceAll('opened trade during all-engine run', 'opened trade during account-scoped engine run')
      .replaceAll("executionMode: 'all_enabled_engines',", "executionMode: 'selected_engine_only',");
    return out;
  }, [
    "executionMode: 'selected_engine_only'",
    'engine_scope_mismatch',
    'accountEngineIsolation=true',
    ': [configuredEngine]',
  ]);

  patchFile(root, 'server/ictAutoTrade.js', (source) => {
    let out = source;
    if (!out.includes("from './ictWatchlist.js'")) {
      out = out.replace(
        "import { applyCombinedLearningCalibration } from './engineTradeLearning.js';",
        "import { applyCombinedLearningCalibration } from './engineTradeLearning.js';\nimport { configuredIctWatchlist } from './ictWatchlist.js';",
      );
    }
    out = replaceRequired(
      out,
      "  const scanPairs = Array.isArray(pairs) && pairs.length ? pairs : null;\n  log(`scan started scanMode=${scanMode} pairs=${scanPairs?.length ? scanPairs.join(',') : 'ALL'}`);",
      "  const hardWatchlist = configuredIctWatchlist();\n  const allowedPairs = new Set(hardWatchlist);\n  const requestedPairs = Array.isArray(pairs) && pairs.length\n    ? [...new Set(pairs.map((pair) => String(pair || '').trim().toUpperCase()).filter(Boolean))]\n    : hardWatchlist;\n  const scanPairs = requestedPairs.filter((pair) => allowedPairs.has(pair));\n  const blockedPairs = requestedPairs.filter((pair) => !allowedPairs.has(pair));\n  if (blockedPairs.length) log(`hard-watchlist blocked pairs=${blockedPairs.join(',')}`);\n  log(`scan started scanMode=${scanMode} pairs=${scanPairs.join(',')} hardWatchlist=${hardWatchlist.join(',')}`);\n  if (!scanPairs.length) {\n    return {\n      scanned: 0, qualified: 0, executed: [],\n      skipped: [{ reason: 'ICT hard watchlist rejected every requested pair', pairs: blockedPairs }],\n      nearQualifiedPairs: [], hotPairs: [], lateEntryPairs: [],\n      hardWatchlist, blockedPairs, executionAllowed: false,\n    };\n  }",
      'ICT hard scan watchlist',
    );
    return out;
  }, [
    'configuredIctWatchlist',
    'hard-watchlist blocked pairs=',
    'ICT hard watchlist rejected every requested pair',
  ]);

  patchFile(root, 'server/ictExecution.js', (source) => {
    let out = source;
    if (!out.includes("from './ictWatchlist.js'")) {
      out = out.replace(
        "import { analyzeICTPair, ictExecConfig } from './ictEngine.js';",
        "import { analyzeICTPair, ictExecConfig } from './ictEngine.js';\nimport { configuredIctWatchlist } from './ictWatchlist.js';",
      );
    }
    out = replaceRequired(
      out,
      "  const { pair, direction, ictSignalId } = params;\n  let entry = Number(params.entry);",
      "  const { pair, direction, ictSignalId } = params;\n  const normalizedPair = String(pair || '').trim().toUpperCase();\n  const hardWatchlist = configuredIctWatchlist();\n  if (!hardWatchlist.includes(normalizedPair)) {\n    return blocked(`ICT hard watchlist rejected ${normalizedPair || 'missing pair'}; allowed=${hardWatchlist.join(',')}.`);\n  }\n  let entry = Number(params.entry);",
      'ICT execution watchlist gate',
    );
    return out;
  }, [
    'configuredIctWatchlist',
    'ICT hard watchlist rejected',
  ]);

  patchFile(root, 'server/v3IndependentScanner.js', (source) => {
    let out = source;
    out = replaceRequired(
      out,
      `const DEFAULT_V3_WATCHLIST = [
  'EUR_USD',
  'GBP_USD',
  'USD_JPY',
  'USD_CAD',
  'USD_CHF',
  'AUD_USD',
  'NZD_USD',
  'EUR_GBP',
  'EUR_CHF',
  'AUD_CAD',
  'GBP_JPY',
  'EUR_JPY',
];`,
      `export const DEFAULT_V3_WATCHLIST = Object.freeze([
  'EUR_USD',
  'GBP_USD',
  'USD_JPY',
  'USD_CAD',
  'USD_CHF',
  'AUD_USD',
  'NZD_USD',
  'EUR_GBP',
  'EUR_CHF',
  'AUD_CAD',
  'GBP_JPY',
  'EUR_JPY',
]);`,
      'V3 fixed watchlist constant',
    );
    out = replaceRequired(
      out,
      `function configuredWatchlist() {
  const raw = process.env.FOREX_V3_WATCHLIST || process.env.FOREX_WATCHLIST || '';
  if (!raw.trim()) return DEFAULT_V3_WATCHLIST;
  return [...new Set(raw.split(',').map((pair) => pair.trim().toUpperCase()).filter(Boolean))];
}`,
      `export function configuredV3Watchlist() {
  return [...DEFAULT_V3_WATCHLIST];
}`,
      'V3 environment watchlist override removal',
    );
    out = out.replaceAll('configuredWatchlist()', 'configuredV3Watchlist()');
    out = replaceRequired(
      out,
      `  const watchlist = [...new Set(
    (Array.isArray(pairs) && pairs.length ? pairs : configuredV3Watchlist())
      .map((pair) => String(pair).toUpperCase()),
  )];`,
      `  const hardWatchlist = configuredV3Watchlist();
  const allowedPairs = new Set(hardWatchlist);
  const requestedPairs = Array.isArray(pairs) && pairs.length ? pairs : hardWatchlist;
  const watchlist = [...new Set(
    requestedPairs
      .map((pair) => String(pair || '').trim().toUpperCase())
      .filter((pair) => allowedPairs.has(pair)),
  )];`,
      'V3 requested-pair intersection',
    );
    return out;
  }, [
    'export const DEFAULT_V3_WATCHLIST = Object.freeze([',
    'export function configuredV3Watchlist()',
    '.filter((pair) => allowedPairs.has(pair))',
  ]);

  patchFile(root, 'server/engineTradeLearning.js', (source) => {
    let out = source.replace(
      '/engine_executed_|engine_learning_adjustment_audit/i',
      '/engine_executed_|engine_account_accuracy_7d|engine_account_pair_accuracy_7d|engine_learning_adjustment_audit/i',
    );
    if (!out.includes('async function loadAccountRows(')) {
      out = out.replace(
        `async function loadRows(view, accountId, engine, pair) {
  const supabase = db();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from(view)
    .select('*')
    .eq('broker_account_id', accountId)
    .eq('engine', engine)
    .eq('pair', pair)
    .eq('horizon_minutes', 60);
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}`,
        `async function loadRows(view, accountId, engine, pair) {
  const supabase = db();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from(view)
    .select('*')
    .eq('broker_account_id', accountId)
    .eq('engine', engine)
    .eq('pair', pair)
    .eq('horizon_minutes', 60);
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function loadAccountRows(view, accountId, engine) {
  const supabase = db();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from(view)
    .select('*')
    .eq('broker_account_id', accountId)
    .eq('engine', engine);
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}`,
      );
    }
    out = replaceRequired(
      out,
      `    const [pairRows, contextStats, confirmationStats, qualityRows] = await Promise.all([
      loadRows('engine_executed_pair_stats', accountId, normalizedEngine, normalizedPair),
      loadRows('engine_executed_context_stats', accountId, normalizedEngine, normalizedPair),
      loadRows('engine_executed_confirmation_stats', accountId, normalizedEngine, normalizedPair),
      loadRows('engine_execution_quality_stats', accountId, normalizedEngine, normalizedPair),
    ]);`,
      `    const [pairRows, recentPairRows, accountRows7d, contextStats, confirmationStats, qualityRows] = await Promise.all([
      loadRows('engine_executed_pair_stats', accountId, normalizedEngine, normalizedPair),
      loadRows('engine_account_pair_accuracy_7d', accountId, normalizedEngine, normalizedPair),
      loadAccountRows('engine_account_accuracy_7d', accountId, normalizedEngine),
      loadRows('engine_executed_context_stats', accountId, normalizedEngine, normalizedPair),
      loadRows('engine_executed_confirmation_stats', accountId, normalizedEngine, normalizedPair),
      loadRows('engine_execution_quality_stats', accountId, normalizedEngine, normalizedPair),
    ]);`,
      'account accuracy profile query',
    );
    out = replaceRequired(
      out,
      `      pairSummary: pairRows[0] || null,
      contextStats,`,
      `      pairSummary: pairRows[0] || null,
      recentPairSummary7d: recentPairRows[0] || null,
      accountSummary7d: accountRows7d[0] || null,
      contextStats,`,
      'account accuracy profile fields',
    );
    return out;
  }, [
    'async function loadAccountRows(',
    "loadAccountRows('engine_account_accuracy_7d'",
    'recentPairSummary7d:',
    'accountSummary7d:',
  ]);

  patchFile(root, 'server/engineTradeLearningCore.js', (source) => {
    let out = source;
    out = replaceRequired(
      out,
      `  const maxAdjustment = clamp(finiteNumber(options.maxAdjustment, 3), 0, 3);
  const sampleSize = finiteNumber(profile.pairSummary?.outcomes ?? profile.sampleSize, 0);
  const stage = stageFor(sampleSize, { displayMinimum, liveMinimum, fullWeightMinimum });`,
      `  const maxAdjustment = clamp(finiteNumber(options.maxAdjustment, 3), 0, 3);
  const pairSampleSize = finiteNumber(profile.pairSummary?.outcomes ?? profile.sampleSize, 0);
  const recentPairSampleSize = finiteNumber(profile.recentPairSummary7d?.outcomes, 0);
  const accountSampleSize = finiteNumber(profile.accountSummary7d?.outcomes, 0);
  const sampleSize = Math.max(pairSampleSize, recentPairSampleSize, accountSampleSize);
  const stage = stageFor(sampleSize, { displayMinimum, liveMinimum, fullWeightMinimum });`,
      'account sample staging',
    );
    if (!out.includes("'engine_account_accuracy_7d'")) {
      out = out.replace(
        `  const components = [];
  const pairSummary = profile.pairSummary || {};`,
        `  const components = [];
  const accountSummary7d = profile.accountSummary7d || {};
  const accountSignal = expectancySignal(accountSummary7d.expectancy_r, 0.25, 0.08);
  if (accountSampleSize >= displayMinimum && accountSignal !== 0) {
    const weight = evidenceWeight(accountSampleSize, displayMinimum, fullWeightMinimum);
    components.push(component(
      'engine_account_accuracy_7d',
      accountSignal * 0.75 * weight,
      accountSampleSize,
      accountSummary7d.expectancy_r,
      \`${'${profileEngine.toUpperCase()}'} account-level accuracy over the latest seven trading days is ${'${accountSignal > 0 ? \'supportive\' : \'adverse\'}'}.\`,
      { tradingDays: finiteNumber(accountSummary7d.trading_days, 0), winRate: finiteNumber(accountSummary7d.win_rate, null) },
    ));
  }

  const recentPairSummary7d = profile.recentPairSummary7d || {};
  const recentPairSignal = expectancySignal(recentPairSummary7d.expectancy_r, 0.3, 0.1);
  if (recentPairSampleSize >= displayMinimum && recentPairSignal !== 0) {
    const weight = evidenceWeight(recentPairSampleSize, displayMinimum, fullWeightMinimum);
    components.push(component(
      'engine_pair_accuracy_7d',
      recentPairSignal * 0.65 * weight,
      recentPairSampleSize,
      recentPairSummary7d.expectancy_r,
      \`${'${profileEngine.toUpperCase()} ${profilePair}'} recent seven-trading-day expectancy is ${'${recentPairSignal > 0 ? \'positive\' : \'negative\'}'}.\`,
    ));
  }

  const pairSummary = profile.pairSummary || {};`,
      );
    }
    out = out.replace(
      `    profileEngine,
    profilePair,
    matchedContext,`,
      `    profileEngine,
    profilePair,
    pairSampleSize,
    recentPairSampleSize,
    accountSampleSize,
    matchedContext,`,
    );
    return out;
  }, [
    'const accountSampleSize =',
    "'engine_account_accuracy_7d'",
    "'engine_pair_accuracy_7d'",
    'recentPairSampleSize,',
  ]);

  patchFile(root, 'server/ictAutoScheduler.js', (source) => {
    let out = source;
    if (!out.includes('let lastEngineLearningBackfillDateKey')) {
      out = out.replace(
        'let lastDailyStudyDateKey = null;',
        'let lastDailyStudyDateKey = null;\nlet lastEngineLearningBackfillDateKey = null;',
      );
    }
    if (!out.includes('void engineLearningBackfillTick(nextUrl, secret')) {
      out = out.replace(
        '  void transactionSyncTick(nextUrl, secret);\n  void dailyMarketStudyTick(nextUrl, secret);',
        "  void transactionSyncTick(nextUrl, secret);\n  void engineLearningBackfillTick(nextUrl, secret, { force: true });\n  void dailyMarketStudyTick(nextUrl, secret);",
      );
    }
    if (!out.includes('export async function engineLearningBackfillTick')) {
      out = out.replace(
        `async function transactionSyncTick(nextUrl, secret) {
  return post(nextUrl, secret, '/api/cron/oanda-transaction-sync', { source: 'railway-scheduler' }, '[OANDA_TX_SYNC]');
}
`,
        `async function transactionSyncTick(nextUrl, secret) {
  return post(nextUrl, secret, '/api/cron/oanda-transaction-sync', { source: 'railway-scheduler' }, '[OANDA_TX_SYNC]');
}

export async function engineLearningBackfillTick(nextUrl, secret, { now = new Date(), force = false } = {}) {
  const dayKey = newYorkDateKey(now);
  if (!force && lastEngineLearningBackfillDateKey === dayKey) {
    return { ok: true, skipped: true, reason: 'engine_learning_backfill_already_completed', dayKey };
  }
  const result = await post(nextUrl, secret, '/api/cron/engine-learning-backfill', {
    source: force ? 'railway-startup' : 'daily-market-study',
    tradingDays: 7,
    calendarLookbackDays: 14,
  }, \`[ENGINE_LEARNING_BACKFILL][dayKey=${'${dayKey}'}]\`);
  if (result.ok) lastEngineLearningBackfillDateKey = dayKey;
  return { ...result, dayKey };
}
`,
      );
    }
    out = replaceRequired(
      out,
      `  const ok = studiesOk && learning.ok;
  if (ok) lastDailyStudyDateKey = dayKey;
  return { ok, dayKey, results, learning };`,
      `  const accountAccuracy = studiesOk
    ? await engineLearningBackfillTick(nextUrl, secret, { now, force: true })
    : { ok: false, skipped: true, reason: 'daily_market_study_failed' };
  const ok = studiesOk && learning.ok && accountAccuracy.ok;
  if (ok) lastDailyStudyDateKey = dayKey;
  return { ok, dayKey, results, learning, accountAccuracy };`,
      'daily study account backfill',
    );
    if (!out.includes('lastEngineLearningBackfillDateKey = null;')) {
      out = out.replace(
        '  timers = [];\n  for (const engine of AUTO_ENGINES) clearEngineWatchState(engine);',
        '  timers = [];\n  lastEngineLearningBackfillDateKey = null;\n  for (const engine of AUTO_ENGINES) clearEngineWatchState(engine);',
      );
    }
    return out;
  }, [
    'export async function engineLearningBackfillTick',
    "'/api/cron/engine-learning-backfill'",
    'tradingDays: 7',
    'accountAccuracy',
  ]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  applyAccountEngineIsolation(DEFAULT_ROOT);
}
