import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function write(relative, source) {
  fs.writeFileSync(path.join(ROOT, relative), source, 'utf8');
}

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`[ICT_QUALIFICATION_CONTRACT] missing ${label}`);
  return source.replace(before, () => after);
}

function insertAfter(source, anchor, addition, label) {
  if (source.includes(addition.trim())) return source;
  if (!source.includes(anchor)) throw new Error(`[ICT_QUALIFICATION_CONTRACT] missing ${label}`);
  return source.replace(anchor, () => `${anchor}${addition}`);
}

// ---------------------------------------------------------------------------
// 1) One authoritative live scan/execution window: 02:30-10:30 ET.
// The 02:00-02:29 period is reserved for the current-day market study.
// ---------------------------------------------------------------------------
let windowSource = read('server/autoAiWindow.js');
windowSource = windowSource
  .replace(
    ' * All engines begin scanning at 02:00 ET so they can build watch state before\n * entries are allowed. The 02:00–02:29 ET period is study/scan-only; new orders\n * may be submitted from 02:30 ET through 09:59 ET.',
    ' * The current-day market study runs at 02:00 ET. Live scanning and new-order\n * execution use one shared 02:30–10:30 ET weekday window for every engine.',
  )
  .replace(
    `export const AUTO_AI_SCAN_WINDOW = Object.freeze({\n  startMin: 120,\n  endMin: 600,`,
    `export const AUTO_AI_SCAN_WINDOW = Object.freeze({\n  startMin: 150,\n  endMin: 630,`,
  )
  .replaceAll('    endMin: 600,', '    endMin: 630,')
  .replace(
    "return 'outside_auto_ai_scan_window_02:00-10:00_ET_weekdays';",
    "return 'outside_auto_ai_scan_window_02:30-10:30_ET_weekdays';",
  );
write('server/autoAiWindow.js', windowSource);

// ---------------------------------------------------------------------------
// 2) Restore the 02:00 current-day study WITHOUT removing the independent 17:30
// reconciliation/review. The scheduler keeps both jobs separate.
// ---------------------------------------------------------------------------
let scheduler = read('server/ictAutoScheduler.js');
scheduler = scheduler
  .replace(
    'export const AUTO_AI_WINDOW = { startMin: 120, endMin: 600 }; // scan: 02:00–10:00 ET, Monday–Friday',
    'export const AUTO_AI_WINDOW = { startMin: 150, endMin: 630 }; // live scan: 02:30–10:30 ET, Monday–Friday',
  )
  .replace(
    'export const AUTO_AI_EXECUTION_WINDOW = { startMin: 150, endMin: 600 }; // entries: 02:30–10:00 ET',
    'export const AUTO_AI_EXECUTION_WINDOW = { startMin: 150, endMin: 630 }; // entries: 02:30–10:30 ET',
  );

if (!scheduler.includes('MORNING_MARKET_STUDY_WINDOW')) {
  scheduler = scheduler.replace(
    'export const DAILY_MARKET_STUDY_WINDOW = { startMin: 1050, endMin: 1080 }; // 17:30–18:00 ET, end-of-day market + trade review',
    'export const MORNING_MARKET_STUDY_WINDOW = { startMin: 120, endMin: 150 }; // 02:00–02:30 ET, current-day study\nexport const DAILY_MARKET_STUDY_WINDOW = { startMin: 1050, endMin: 1080 }; // 17:30–18:00 ET, end-of-day market + trade review',
  );
}
if (!scheduler.includes('let lastMorningStudyDateKey')) {
  scheduler = scheduler.replace(
    'let timers = [];',
    'let timers = [];\nlet lastMorningStudyDateKey = null;',
  );
}
if (!scheduler.includes('inMorningMarketStudyWindow')) {
  scheduler = scheduler.replace(
    'export function inActiveTradeManagementWindow(date = new Date()) { return inWindow(date, ACTIVE_TRADE_MANAGEMENT_WINDOW); }',
    'export function inActiveTradeManagementWindow(date = new Date()) { return inWindow(date, ACTIVE_TRADE_MANAGEMENT_WINDOW); }\nexport function inMorningMarketStudyWindow(date = new Date()) { return inWindow(date, MORNING_MARKET_STUDY_WINDOW); }',
  );
}

scheduler = scheduler
  .replace(
    '`[AUTO_AI] endOfDayReview=17:30_ET scans=02:00–10:00_ET entries=02:30–10:00_ET weekdays_only ` +',
    '`[AUTO_AI] morningStudy=02:00_ET endOfDayReview=17:30_ET scans=02:30–10:30_ET entries=02:30–10:30_ET weekdays_only ` +',
  )
  .replace(
    '`[AUTO_AI] study=02:00_ET scans=02:00–10:00_ET entries=02:30–10:00_ET weekdays_only ` +',
    '`[AUTO_AI] morningStudy=02:00_ET endOfDayReview=17:30_ET scans=02:30–10:30_ET entries=02:30–10:30_ET weekdays_only ` +',
  );

if (!scheduler.includes('morningMarketStudyTick(nextUrl, secret)')) {
  scheduler = scheduler.replace(
    '  addTimer(setInterval(() => void dailyMarketStudyTick(nextUrl, secret), DAILY_MARKET_STUDY_INTERVAL_MS));',
    '  addTimer(setInterval(() => void morningMarketStudyTick(nextUrl, secret), DAILY_MARKET_STUDY_INTERVAL_MS));\n  addTimer(setInterval(() => void dailyMarketStudyTick(nextUrl, secret), DAILY_MARKET_STUDY_INTERVAL_MS));',
  );
}
if (!scheduler.includes('void morningMarketStudyTick(nextUrl, secret);')) {
  scheduler = scheduler.replace(
    '  // Trade learning is intentionally finalized with the 17:30 ET end-of-day review, not on arbitrary restarts.\n  void dailyMarketStudyTick(nextUrl, secret);',
    '  // Initialize the current-day ICT/PPR study at 02:00 ET. The 17:30 job remains a separate review.\n  void morningMarketStudyTick(nextUrl, secret);\n  // Trade learning is intentionally finalized with the 17:30 ET end-of-day review, not on arbitrary restarts.\n  void dailyMarketStudyTick(nextUrl, secret);',
  );
}

if (!scheduler.includes('export async function morningMarketStudyTick')) {
  scheduler = scheduler.replace(
    'export async function engineLearningBackfillTick(nextUrl, secret, { now = new Date(), force = false, source = \'end-of-day-market-review\' } = {}) {',
    `export async function morningMarketStudyTick(nextUrl, secret, now = new Date()) {\n  if (!inMorningMarketStudyWindow(now)) {\n    return { ok: true, skipped: true, reason: 'outside_morning_market_study_window' };\n  }\n  const dayKey = newYorkDateKey(now);\n  if (lastMorningStudyDateKey === dayKey) {\n    return { ok: true, skipped: true, reason: 'morning_market_study_already_completed', dayKey };\n  }\n  const results = [];\n  for (const engine of ['ict', 'ppr']) {\n    const runId = makeRunId();\n    results.push(await post(nextUrl, secret, '/api/cron/auto-ai-trading-extended', {\n      source: 'morning-market-study', runId, scanMode: 'daily_study', pairs: [], engine,\n    }, \`[MORNING_STUDY][\${engine.toUpperCase()}][runId=\${runId}]\`));\n  }\n  const ok = results.every((result) => result.ok);\n  if (ok) lastMorningStudyDateKey = dayKey;\n  return { ok, dayKey, results, executionAllowed: false };\n}\n\nexport async function engineLearningBackfillTick(nextUrl, secret, { now = new Date(), force = false, source = 'end-of-day-market-review' } = {}) {`,
  );
}

if (!scheduler.includes('lastMorningStudyDateKey = null;\n  for (const engine')) {
  scheduler = scheduler.replace(
    '  timers = [];\n  for (const engine of AUTO_ENGINES) clearEngineWatchState(engine);',
    '  timers = [];\n  lastMorningStudyDateKey = null;\n  lastDailyStudyDateKey = null;\n  lastEngineLearningBackfillDateKey = null;\n  for (const engine of AUTO_ENGINES) clearEngineWatchState(engine);',
  );
}
write('server/ictAutoScheduler.js', scheduler);

// ---------------------------------------------------------------------------
// 3) The persistent PO3 model may progress a reversal from the direction stored
// by the current-day study even while D1/H4 are temporarily split. Continuations
// still require explicit D1/H4 alignment in the strategy router/corrective gate.
// ---------------------------------------------------------------------------
let marketMaker = read('server/ictMarketMakerModel.js');
marketMaker = replaceOnce(
  marketMaker,
  `  if (!direction || observation?.htfAligned !== true) {\n    return {\n      cycle: context?.cycle ?? null,\n      changed: false,\n      entryAuthorization: {\n        ...baseAuthorization,\n        reason: 'Daily and H4 do not provide an aligned market-maker direction.',\n      },\n    };\n  }`,
  `  const studiedReversalDirection = observation?.studiedReversalDirection === true;\n  if (!direction || (observation?.htfAligned !== true && !studiedReversalDirection)) {\n    return {\n      cycle: context?.cycle ?? null,\n      changed: false,\n      entryAuthorization: {\n        ...baseAuthorization,\n        reason: 'No valid continuation alignment or current-day studied reversal direction is available.',\n      },\n    };\n  }`,
  'market-maker reversal direction gate',
);
write('server/ictMarketMakerModel.js', marketMaker);

// ---------------------------------------------------------------------------
// 4) Corrective gate: D1/H4 alignment is continuation-specific. A reversal is
// governed by HTF tap -> sweep -> displacement -> CISD/MSS -> fresh M5.
// ---------------------------------------------------------------------------
let corrective = read('server/ictCorrectiveGate.js');
const universalHtf = `  if (!wanted || d1 !== wanted || h4 !== wanted || timeframeBias?.d1H4Aligned === false) {\n    fail(ICT_FAILURE_CODES.HTF_DIRECTION_NOT_ALIGNED, 'D1 and H4 must agree with the intended trade direction.');\n  }\n`;
if (corrective.includes(universalHtf)) {
  corrective = corrective.replace(universalHtf, '');
}
const continuationAnchor = `  if (family === 'continuation') {\n`;
const continuationHtf = `    if (!wanted || d1 !== wanted || h4 !== wanted || timeframeBias?.d1H4Aligned === false) {\n      fail(ICT_FAILURE_CODES.HTF_DIRECTION_NOT_ALIGNED, 'Continuation requires D1 and H4 to agree with the intended trade direction.');\n    }\n`;
if (!corrective.includes(continuationHtf)) {
  corrective = corrective.replace(continuationAnchor, `${continuationAnchor}${continuationHtf}`);
}
write('server/ictCorrectiveGate.js', corrective);

// ---------------------------------------------------------------------------
// 5) Engine direction/confidence: D1/H4 still own continuation direction. When
// they conflict, a current-day studied direction may ONLY feed the full reversal
// sequence. This prevents the old blanket 0% / blanket rejection behavior.
// ---------------------------------------------------------------------------
let engine = read('server/ictEngine.js');
engine = replaceOnce(
  engine,
  `export function computeIctConfidence(p = {}) {\n  if (!p.htfAligned) return 0;\n  let c = 40;`,
  `export function computeIctConfidence(p = {}) {\n  if (!p.htfAligned && !p.reversalContext) return 0;\n  let c = p.htfAligned ? 40 : 28;`,
  'reversal-aware confidence base',
);

engine = replaceOnce(
  engine,
  `  const htfAligned = dailyTfBias !== 'neutral' && dailyTfBias === h4TfBias;\n  const dir = htfAligned ? toLS(dailyTfBias) : null;\n  const want = sign(dir); // null when Daily/H4 not aligned\n  const analysisDirection = dir === 'long' ? 'buy' : dir === 'short' ? 'sell' : 'none';`,
  `  const htfAligned = dailyTfBias !== 'neutral' && dailyTfBias === h4TfBias;\n  const studiedDirection = marketMakerContext?.studyReady === true\n    ? sign(marketMakerContext?.cycle?.direction)\n    : null;\n  // Continuation direction comes only from D1/H4 agreement. When they are split,\n  // the current-day study may supply direction only for the stricter reversal path.\n  const want = htfAligned ? dailyTfBias : studiedDirection;\n  const dir = toLS(want);\n  const reversalStudyDirection = !htfAligned && Boolean(want) && marketMakerContext?.studyReady === true;\n  const analysisDirection = dir === 'long' ? 'buy' : dir === 'short' ? 'sell' : 'none';`,
  'study-directed reversal bias',
);

if (!engine.includes('studiedReversalDirection: reversalStudyDirection')) {
  engine = engine.replace(
    `    htfAligned,\n    h1Aligned,`,
    `    htfAligned,\n    studiedReversalDirection: reversalStudyDirection,\n    h1Aligned,`,
  );
}

engine = replaceOnce(
  engine,
  `  const hardFails = [];\n  if (!htfAligned) hardFails.push('Hard gate: Daily and 4H directional bias are not aligned.');\n  if (htfAligned && !kz.inKillzone) hardFails.push('Hard gate: no active killzone/session.');\n  if (htfAligned && marketMakerContext?.studyReady !== true) {\n    hardFails.push('Hard gate: the required 02:00 ET ICT market study is not complete for the current New York trading day.');\n  }\n  if (htfAligned && !entryAuthorization.ready) {`,
  `  const hardFails = [];\n  if (!htfAligned && !reversalStudyDirection) {\n    hardFails.push('Hard gate: Daily and 4H are not aligned for continuation and no current-day studied reversal direction is available.');\n  }\n  if (want && !kz.inKillzone) hardFails.push('Hard gate: no active ICT killzone/session.');\n  if (want && marketMakerContext?.studyReady !== true) {\n    hardFails.push('Hard gate: the required 02:00 ET ICT market study is not complete for the current New York trading day.');\n  }\n  if (want && !entryAuthorization.ready) {`,
  'strategy-family hard gates',
);
engine = engine
  .replace("  if (htfAligned && !entryTrigger) hardFails.push('Hard gate: no 5M entry-timing trigger.');", "  if (want && !entryTrigger) hardFails.push('Hard gate: no 5M entry-timing trigger.');")
  .replace("  if (htfAligned && want && (!setup || !setup.ok)) hardFails.push(`Hard gate: ${setup?.reason || 'no executable 5M entry/target.'}`);", "  if (want && (!setup || !setup.ok)) hardFails.push(`Hard gate: ${setup?.reason || 'no executable 5M entry/target.'}`);")
  .replace('    htfAligned,\n    killzoneQuality:', '    htfAligned,\n    reversalContext: reversalStudyDirection,\n    killzoneQuality:')
  .replace('  if (htfAligned && entryAuthorization.ready && !freshImpulse) {', '  if (want && entryAuthorization.ready && !freshImpulse) {')
  .replace('  if (htfAligned && entryAuthorization.ready && !correctiveGate.passed) {', '  if (want && entryAuthorization.ready && !correctiveGate.passed) {')
  .replace("  const ictBias = htfAligned ? dailyTfBias : 'neutral';", "  const ictBias = want || 'neutral';");
write('server/ictEngine.js', engine);

// ---------------------------------------------------------------------------
// 6) Autonomous qualification: direct continuations must not be forced through
// DISTRIBUTION_ACTIVE. Also repair a missed 02:00 study only for pairs whose
// current-day study is genuinely absent, so a service restart cannot deadlock
// the entire trading day or reset an existing cycle.
// ---------------------------------------------------------------------------
let auto = read('server/ictAutoTrade.js');
if (!auto.includes("from './ictMarketMakerState.js'")) {
  auto = auto.replace(
    "import { applyCombinedLearningCalibration } from './engineTradeLearning.js';",
    "import { applyCombinedLearningCalibration } from './engineTradeLearning.js';\nimport { loadIctMarketMakerContext } from './ictMarketMakerState.js';",
  );
}
auto = auto
  .replace(
    `    analysis?.marketMakerModel?.studyReady === true &&\n    analysis?.marketMakerModel?.stage === 'DISTRIBUTION_ACTIVE' &&\n    Number.isFinite(confidence)`,
    `    analysis?.marketMakerModel?.studyReady === true &&\n    (entryAuthorization?.requiresMarketMakerActive !== true ||\n      analysis?.marketMakerModel?.stage === 'DISTRIBUTION_ACTIVE') &&\n    Number.isFinite(confidence)`,
  )
  .replace('const freshTrigger = item?.freshImpulse === true || (triggerAge != null && triggerAge <= 1);', 'const freshTrigger = item?.freshImpulse === true || (triggerAge != null && triggerAge <= 2);');

if (!auto.includes('missingStudyPairs')) {
  auto = auto.replace(
    `  const { analyses: rawAnalyses } = await analyzeICTPairs(scanPairs, { client, now, scanMode });`,
    `  // Recovery guard: if Railway/Vercel was unavailable during the 02:00 study,\n  // initialize only the pairs that truly lack a current-day study. Existing cycles\n  // are never reset by this path.\n  const missingStudyPairs = [];\n  for (const pair of scanPairs) {\n    try {\n      const context = await loadIctMarketMakerContext({ client, pair, now });\n      if (context?.studyReady !== true) missingStudyPairs.push(pair);\n    } catch (error) {\n      log(\`study readiness check failed pair=\${pair} reason=\"\${error?.message || error}\"\`);\n    }\n  }\n  if (missingStudyPairs.length) {\n    log(\`recovering missing current-day study pairs=\${missingStudyPairs.join(',')}\`);\n    await runDailyMarketStudy({ client, engine: 'ict', pairs: missingStudyPairs, now });\n  }\n\n  const { analyses: rawAnalyses } = await analyzeICTPairs(scanPairs, { client, now, scanMode });`,
  );
}
write('server/ictAutoTrade.js', auto);

// Keep the final executable recompute strategy-specific as well.
let execution = read('server/ictExecution.js');
execution = execution.replace(
  `  if (\n    analysis?.marketMakerModel?.studyReady !== true ||\n    analysis?.marketMakerModel?.stage !== 'DISTRIBUTION_ACTIVE'\n  ) {\n    return blocked('ICT execution requires a current-day 02:00 ET study and an activated persistent Power-of-Three distribution cycle.');\n  }`,
  `  if (analysis?.marketMakerModel?.studyReady !== true) {\n    return blocked('ICT execution requires the current-day 02:00 ET market study.');\n  }\n  const requiresMarketMakerActive = analysis?.entryAuthorization?.requiresMarketMakerActive === true;\n  if (requiresMarketMakerActive && analysis?.marketMakerModel?.stage !== 'DISTRIBUTION_ACTIVE') {\n    return blocked(\n      \`ICT \${analysis?.entryAuthorization?.strategy || analysis?.entryAuthorization?.family || 'market-maker'} strategy requires an activated persistent Power-of-Three distribution cycle.\`,\n    );\n  }`,
);
write('server/ictExecution.js', execution);

// ---------------------------------------------------------------------------
// Fail loudly if any known regression returns after a legacy source generator.
// ---------------------------------------------------------------------------
const combined = [
  windowSource,
  scheduler,
  marketMaker,
  corrective,
  engine,
  auto,
  execution,
].join('\n');

const required = [
  'startMin: 150,\n  endMin: 630',
  'morningStudy=02:00_ET endOfDayReview=17:30_ET scans=02:30–10:30_ET entries=02:30–10:30_ET',
  'export async function morningMarketStudyTick',
  'studiedReversalDirection: reversalStudyDirection',
  'if (!p.htfAligned && !p.reversalContext) return 0;',
  'Continuation requires D1 and H4 to agree with the intended trade direction.',
  'requiresMarketMakerActive !== true',
  'missingStudyPairs',
];
for (const marker of required) {
  if (!combined.includes(marker)) {
    throw new Error(`[ICT_QUALIFICATION_CONTRACT] verification missing: ${marker}`);
  }
}
if (corrective.includes("D1 and H4 must agree with the intended trade direction.")) {
  throw new Error('[ICT_QUALIFICATION_CONTRACT] universal D1/H4 corrective gate returned');
}
if (auto.includes("analysis?.marketMakerModel?.stage === 'DISTRIBUTION_ACTIVE' &&\n    Number.isFinite(confidence)")) {
  throw new Error('[ICT_QUALIFICATION_CONTRACT] Auto AI universally requires DISTRIBUTION_ACTIVE');
}
if (scheduler.includes('scans=02:00–10:00_ET') || scheduler.includes('entries=02:30–10:00_ET')) {
  throw new Error('[ICT_QUALIFICATION_CONTRACT] stale live window remains in scheduler diagnostic');
}

console.log('[ICT_QUALIFICATION_CONTRACT] restored 02:00 study, preserved 17:30 review, live window 02:30-10:30 ET, and strategy-specific qualification gates.');
