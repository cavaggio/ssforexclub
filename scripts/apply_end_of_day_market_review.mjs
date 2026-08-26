import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

function write(relativePath, content) {
  writeFileSync(resolve(ROOT, relativePath), content, 'utf8');
  console.log(`[EOD_REVIEW] updated ${relativePath}`);
}

function replaceRequired(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`[EOD_REVIEW] missing ${label}`);
  return source.replace(before, after);
}

function replaceBetween(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`[EOD_REVIEW] missing ${label} start`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`[EOD_REVIEW] missing ${label} end`);
  return source.slice(0, start) + replacement + '\n\n' + source.slice(end);
}

// 1) Scheduler: 17:30 ET end-of-day market + trade review. 02:00–02:30 remains scan-only.
{
  const path = 'server/ictAutoScheduler.js';
  let source = read(path);
  source = replaceRequired(
    source,
    "export const DAILY_MARKET_STUDY_WINDOW = { startMin: 120, endMin: 150 }; // 02:00–02:30 ET, before entries",
    "export const DAILY_MARKET_STUDY_WINDOW = { startMin: 1050, endMin: 1080 }; // 17:30–18:00 ET, end-of-day market + trade review",
    'daily review window',
  );
  source = replaceRequired(
    source,
    "[AUTO_AI] study=02:00_ET scans=02:00–10:00_ET entries=02:30–10:00_ET weekdays_only ",
    "[AUTO_AI] endOfDayReview=17:30_ET scans=02:00–10:00_ET entries=02:30–10:00_ET weekdays_only ",
    'scheduler diagnostic',
  );
  source = source.replace(
    "  void engineLearningBackfillTick(nextUrl, secret, { force: true });\n  void dailyMarketStudyTick(nextUrl, secret);",
    "  // Trade learning is intentionally finalized with the 17:30 ET end-of-day review, not on arbitrary restarts.\n  void dailyMarketStudyTick(nextUrl, secret);",
  );
  source = replaceRequired(
    source,
    "export async function engineLearningBackfillTick(nextUrl, secret, { now = new Date(), force = false } = {}) {",
    "export async function engineLearningBackfillTick(nextUrl, secret, { now = new Date(), force = false, source = 'end-of-day-market-review' } = {}) {",
    'engine learning backfill signature',
  );
  source = replaceRequired(
    source,
    "    source: force ? 'railway-startup' : 'daily-market-study',",
    "    source,",
    'engine learning source',
  );

  const replacement = `export async function dailyMarketStudyTick(nextUrl, secret, now = new Date()) {
  if (!inDailyMarketStudyWindow(now)) {
    return { ok: true, skipped: true, reason: 'outside_end_of_day_market_review_window' };
  }
  const dayKey = newYorkDateKey(now);
  if (lastDailyStudyDateKey === dayKey) {
    return { ok: true, skipped: true, reason: 'end_of_day_market_review_already_completed', dayKey };
  }

  // First capture the authoritative broker close events, then reconcile every
  // completed broker trade into actual_trade_lifecycles so realized R, MFE/MAE,
  // failure reasons and post-trade learning are finalized before the market review.
  const transactionSync = await transactionSyncTick(nextUrl, secret);
  const tradeReview = await engineLearningBackfillTick(nextUrl, secret, {
    now,
    force: true,
    source: 'end-of-day-market-review',
  });

  // Review the completed session's market movement after trade outcomes are known.
  // OANDA getCandles excludes incomplete candles by default, so the D/H4/H1/M15/M5
  // study reflects completed movement rather than the newly-opened rollover candle.
  const results = [];
  for (const engine of ['ict', 'ppr']) {
    const runId = makeRunId();
    results.push(await post(nextUrl, secret, '/api/cron/auto-ai-trading-extended', {
      source: 'end-of-day-market-review', runId, scanMode: 'daily_study', pairs: [], engine,
    }, \`[END_OF_DAY_STUDY][\${engine.toUpperCase()}][runId=\${runId}]\`));
  }
  const studiesOk = results.every((result) => result.ok);
  const learning = studiesOk && tradeReview.ok
    ? await post(nextUrl, secret, '/api/cron/edge-learning-refresh', {
        source: 'end-of-day-market-review', dayKey,
      }, \`[EDGE_LEARNING][dayKey=\${dayKey}]\`)
    : { ok: false, skipped: true, reason: studiesOk ? 'trade_review_failed' : 'end_of_day_market_study_failed' };

  const ok = transactionSync.ok && tradeReview.ok && studiesOk && learning.ok;
  if (ok) lastDailyStudyDateKey = dayKey;
  return {
    ok,
    dayKey,
    transactionSync,
    tradeReview,
    accountAccuracy: tradeReview,
    results,
    learning,
  };
}`;
  source = replaceBetween(
    source,
    'export async function dailyMarketStudyTick(nextUrl, secret, now = new Date()) {',
    'function applyReturnedWatchState',
    replacement,
    'daily market review function',
  );
  write(path, source);
}

// 2) Central router: before 02:30, scans may build watch state but cannot be labeled qualified.
{
  const path = 'server/autoAiRouter.js';
  let source = read(path);
  const before = `  const result = await runner(args);\n\n  return { engine: selectedEngine, executionAllowed, ...result };`;
  const after = `  const result = await runner(args);\n\n  if (!dailyStudy && !executionAllowed) {\n    const potentialQualified = Number.isFinite(Number(result?.qualified))\n      ? Math.max(0, Number(result.qualified))\n      : 0;\n    const existingWatching = Number.isFinite(Number(result?.watching))\n      ? Math.max(0, Number(result.watching))\n      : Number.isFinite(Number(result?.watchCount))\n        ? Math.max(0, Number(result.watchCount))\n        : Number.isFinite(Number(result?.qualityWatch))\n          ? Math.max(0, Number(result.qualityWatch))\n          : 0;\n    const scanned = Number.isFinite(Number(result?.scanned))\n      ? Math.max(0, Number(result.scanned))\n      : existingWatching + potentialQualified;\n    const blockedReason = String(args.executionBlockedReason || '');\n    const skipped = Array.isArray(result?.skipped)\n      ? result.skipped.filter((item) => String(item?.reason || '') !== blockedReason)\n      : [];\n\n    return {\n      engine: selectedEngine,\n      ...result,\n      qualified: 0,\n      watching: Math.min(scanned || existingWatching + potentialQualified, existingWatching + potentialQualified),\n      executed: [],\n      skipped,\n      executionAllowed: false,\n      qualificationAllowed: false,\n      preOpenScanOnly: true,\n      preOpenPotentialQualified: potentialQualified,\n      v3Promoted: Object.hasOwn(result || {}, 'v3Promoted') ? 0 : result?.v3Promoted,\n      independentV3Qualified: Object.hasOwn(result || {}, 'independentV3Qualified') ? 0 : result?.independentV3Qualified,\n    };\n  }\n\n  return {\n    engine: selectedEngine,\n    ...result,\n    executionAllowed,\n    qualificationAllowed: !dailyStudy && executionAllowed,\n  };`;
  source = replaceRequired(source, before, after, 'pre-open qualification suppression');
  write(path, source);
}

// 3) Public cron response wording.
{
  const path = 'web/app/api/cron/auto-ai-trading-extended/route.ts';
  let source = read(path);
  source = replaceRequired(
    source,
    "    dailyStudyWindow: '02:00-02:30 America/New_York, Monday-Friday; execution remains blocked during study',",
    "    dailyStudyWindow: '17:30-18:00 America/New_York, Monday-Friday; end-of-day market movement + completed-trade review',",
    'cron daily study response',
  );
  write(path, source);
}

// 4) Keep the diagnostics patcher compatible with the new canonical scheduler string.
{
  const path = 'scripts/apply_scan_rejection_diagnostics.mjs';
  let source = read(path);
  source = replaceRequired(
    source,
    "  const accurate = '[AUTO_AI] study=02:00_ET scans=02:00–10:00_ET entries=02:30–10:00_ET weekdays_only ';",
    "  const accurate = '[AUTO_AI] endOfDayReview=17:30_ET scans=02:00–10:00_ET entries=02:30–10:00_ET weekdays_only ';",
    'diagnostic canonical scheduler string',
  );
  write(path, source);
}

// 5) Scheduler tests.
{
  const path = 'server/ictAutoScheduler.test.js';
  let source = read(path);
  const oldTest = `test('daily market study runs in the 02:00–02:30 ET scan-only window', () => {\n  assert.equal(inDailyMarketStudyWindow(new Date('2026-06-09T05:59:00Z')), false); // 01:59 ET\n  assert.equal(inDailyMarketStudyWindow(new Date('2026-06-09T06:00:00Z')), true); // 02:00 ET\n  assert.equal(inDailyMarketStudyWindow(new Date('2026-06-09T06:29:00Z')), true); // 02:29 ET\n  assert.equal(inDailyMarketStudyWindow(new Date('2026-06-09T06:30:00Z')), false); // 02:30 ET\n  assert.equal(inDailyMarketStudyWindow(new Date('2026-06-06T06:05:00Z')), false); // Saturday\n});`;
  const newTest = `test('end-of-day market and trade review runs at 17:30–18:00 ET on weekdays', () => {\n  assert.equal(inDailyMarketStudyWindow(new Date('2026-06-09T21:29:00Z')), false); // 17:29 ET\n  assert.equal(inDailyMarketStudyWindow(new Date('2026-06-09T21:30:00Z')), true); // 17:30 ET\n  assert.equal(inDailyMarketStudyWindow(new Date('2026-06-09T21:59:00Z')), true); // 17:59 ET\n  assert.equal(inDailyMarketStudyWindow(new Date('2026-06-09T22:00:00Z')), false); // 18:00 ET\n  assert.equal(inDailyMarketStudyWindow(new Date('2026-06-06T21:35:00Z')), false); // Saturday\n});`;
  source = replaceRequired(source, oldTest, newTest, 'scheduler end-of-day window test');
  write(path, source);
}

// 6) Router tests: scan-only means zero qualification before 02:30.
{
  const path = 'server/autoAiRouter.test.js';
  let source = read(path);
  source = replaceRequired(
    source,
    "    assert.equal(result.executionAllowed, false);\n  }\n});\n\ntest('V3, PPR, and ICT all begin execution at 02:30 ET'",
    "    assert.equal(result.executionAllowed, false);\n    assert.equal(result.qualificationAllowed, false);\n    assert.equal(result.qualified, 0);\n  }\n});\n\ntest('pre-entry scans convert would-be qualified setups into watch-only candidates', async () => {\n  for (const engine of ENGINES) {\n    const injected = async (args) => ({\n      scanned: 3,\n      qualified: 2,\n      watching: 1,\n      rejectedCount: 0,\n      executed: [],\n      skipped: [{ pair: 'EUR_USD', reason: args.executionBlockedReason }],\n      hotPairs: ['EUR_USD', 'GBP_USD'],\n    });\n    const result = await runAutoForUser({\n      client: { accountId: 'A', environment: 'live' },\n      engine,\n      now: PRE_ENTRY_SCAN_WINDOW,\n      runIct: engine === 'ict' ? injected : null,\n      runV3: engine === 'v3' ? injected : null,\n      runPpr: engine === 'ppr' ? injected : null,\n    });\n    assert.equal(result.qualificationAllowed, false);\n    assert.equal(result.preOpenScanOnly, true);\n    assert.equal(result.preOpenPotentialQualified, 2);\n    assert.equal(result.qualified, 0);\n    assert.equal(result.watching, 3);\n    assert.deepEqual(result.executed, []);\n    assert.deepEqual(result.skipped, []);\n  }\n});\n\ntest('V3, PPR, and ICT all begin execution at 02:30 ET'",
    'router pre-open assertions',
  );
  source = replaceRequired(
    source,
    "test('02:00 ET daily study can never submit an order', async () => {",
    "test('17:30 ET end-of-day study can never submit an order', async () => {",
    'daily study test name',
  );
  source = replaceRequired(
    source,
    "      now: new Date('2026-07-13T06:05:00Z'),",
    "      now: new Date('2026-07-13T21:35:00Z'),",
    'daily study test time',
  );
  source = replaceRequired(
    source,
    "    assert.equal(result.executionAllowed, false);\n  }\n});\n\ntest('routing: each internal call still runs exactly one engine'",
    "    assert.equal(result.executionAllowed, false);\n    assert.equal(result.qualificationAllowed, false);\n  }\n});\n\ntest('routing: each internal call still runs exactly one engine'",
    'daily study qualification assertion',
  );
  write(path, source);
}

// 7) Diagnostics test wording.
{
  const path = 'scripts/apply_scan_rejection_diagnostics.test.mjs';
  let source = read(path);
  source = replaceRequired(
    source,
    "test('scheduler diagnostic matches the 02:00 study and 02:30 entry windows', () => {",
    "test('scheduler diagnostic matches the 17:30 review and 02:30 entry windows', () => {",
    'diagnostic test title',
  );
  source = replaceRequired(source, "  assert.match(patched, /study=02:00_ET/);", "  assert.match(patched, /endOfDayReview=17:30_ET/);", 'diagnostic test assertion');
  write(path, source);
}

// 8) Learning-pipeline documentation.
{
  const path = 'docs/signal-learning-pipeline.md';
  let source = read(path);
  source = replaceRequired(
    source,
    '4. The Railway scheduler runs `/api/cron/edge-learning-refresh` after the weekday daily market study.',
    '4. At 17:30 ET on weekdays, the Railway scheduler reconciles completed broker trades, finalizes MFE/MAE/realized-R learning, runs the end-of-day market-movement study, then refreshes Edge Intelligence.',
    'learning pipeline runtime step',
  );
  write(path, source);
}

console.log('[EOD_REVIEW] migration complete');
