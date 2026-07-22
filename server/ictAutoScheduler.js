import { getRetraceWatchPairs } from './retraceWatchMode.js';
import { etParts } from './ictTime.js';

export const AUTO_AI_WINDOW = { startMin: 120, endMin: 600 }; // scan: 02:00–10:00 ET, Monday–Friday
export const AUTO_AI_EXECUTION_WINDOW = { startMin: 135, endMin: 600 }; // entries: 02:15–10:00 ET
export const ACTIVE_TRADE_MANAGEMENT_WINDOW = { startMin: 600, endMin: 1050 }; // 10:00–17:30 ET
export const DAILY_MARKET_STUDY_WINDOW = { startMin: 1020, endMin: 1035 }; // 17:00–17:15 ET

const AUTO_ENGINES = Object.freeze(['ict', 'v3', 'ppr']);

function interval(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const AUTO_AI_FULL_SCAN_INTERVAL_MS = interval('AUTO_AI_FULL_SCAN_INTERVAL_MS', 120000);
export const AUTO_AI_NEAR_QUALIFIED_RECHECK_INTERVAL_MS = interval('AUTO_AI_NEAR_QUALIFIED_RECHECK_INTERVAL_MS', 60000);
export const AUTO_AI_HOT_TRIGGER_WATCH_INTERVAL_MS = interval('AUTO_AI_HOT_TRIGGER_WATCH_INTERVAL_MS', 30000);
export const ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS = Math.max(1800000, interval('ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS', 1800000));
export const OANDA_TRANSACTION_SYNC_INTERVAL_MS = interval('OANDA_TRANSACTION_SYNC_INTERVAL_MS', 1800000);
export const DAILY_MARKET_STUDY_INTERVAL_MS = interval('DAILY_MARKET_STUDY_INTERVAL_MS', 300000);

const engineWatchStates = Object.fromEntries(
  AUTO_ENGINES.map((engine) => [engine, { nearQualifiedPairs: new Set(), hotPairs: new Set() }]),
);
let timers = [];
let lastDailyStudyDateKey = null;

function inWindow(date, window) {
  const et = etParts(date);
  return Boolean(et && !et.isWeekend && et.minutesFromMidnight >= window.startMin && et.minutesFromMidnight < window.endMin);
}

export function inAutoAiWindow(date = new Date()) { return inWindow(date, AUTO_AI_WINDOW); }
export function inAutoAiExecutionWindow(date = new Date()) { return inWindow(date, AUTO_AI_EXECUTION_WINDOW); }
export function inActiveTradeManagementWindow(date = new Date()) { return inWindow(date, ACTIVE_TRADE_MANAGEMENT_WINDOW); }
export function inDailyMarketStudyWindow(date = new Date()) { return inWindow(date, DAILY_MARKET_STUDY_WINDOW); }
export function makeRunId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

function normalize(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean))]
    : [];
}

function clearEngineWatchState(engine) {
  const state = engineWatchStates[engine];
  if (!state) return;
  state.nearQualifiedPairs.clear();
  state.hotPairs.clear();
}

function serializedEngineWatchStates() {
  return Object.fromEntries(AUTO_ENGINES.map((engine) => [engine, {
    nearQualifiedPairs: [...engineWatchStates[engine].nearQualifiedPairs],
    hotPairs: [...engineWatchStates[engine].hotPairs],
  }]));
}

export function getAutoAiWatchState() {
  const nearQualifiedPairs = [...new Set(
    AUTO_ENGINES.flatMap((engine) => [...engineWatchStates[engine].nearQualifiedPairs]),
  )];
  const hotPairs = [...new Set(
    AUTO_ENGINES.flatMap((engine) => [...engineWatchStates[engine].hotPairs]),
  )];
  return {
    nearQualifiedPairs,
    hotPairs,
    engineWatchStates: serializedEngineWatchStates(),
    runningTimers: timers.length,
  };
}

function addTimer(timer) {
  if (typeof timer.unref === 'function') timer.unref();
  timers.push(timer);
}

async function post(nextUrl, secret, path, body, tag) {
  const url = `${String(nextUrl).replace(/\/$/, '')}${path}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cron-Secret': secret },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    console.log(`${tag} status=${response.status} ${text.slice(0, 300)}`);
    return { ok: response.ok, status: response.status, body: text };
  } catch (error) {
    console.log(`${tag} unreachable: ${error?.message || error}`);
    return { ok: false, error: error?.message || String(error) };
  }
}

export function startAutoAiScheduler({ intervalMs = AUTO_AI_FULL_SCAN_INTERVAL_MS } = {}) {
  if (String(process.env.ICT_AUTO_AI_SCHEDULER_ENABLED || 'true').toLowerCase() !== 'true') {
    return { started: false, reason: 'disabled_by_env' };
  }
  if (timers.length) return { started: false, reason: 'already_running' };
  const nextUrl = process.env.NEXT_BASE_URL;
  const secret = process.env.AUTO_AI_CRON_SECRET;
  if (!nextUrl || !secret) return { started: false, reason: 'missing_config' };

  const full = Number(intervalMs) > 0 ? Number(intervalMs) : AUTO_AI_FULL_SCAN_INTERVAL_MS;
  console.log(
    `[AUTO_AI] scans=02:00–10:00_ET entries=V3_02:15/PPR_03:00/ICT_05:00 weekdays_only ` +
    `full=${full}ms near=${AUTO_AI_NEAR_QUALIFIED_RECHECK_INTERVAL_MS}ms ` +
    `hot=${AUTO_AI_HOT_TRIGGER_WATCH_INTERVAL_MS}ms engineWatchIsolation=true ` +
    `management=10:00–17:30_ET/${ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS}ms`,
  );

  addTimer(setInterval(() => void tick(nextUrl, secret, {
    scanMode: 'full', pairs: [], engine: null, logTag: '[AUTO_AI][FULL]',
  }), full));
  addTimer(setInterval(() => void tickAllEngineWatches(nextUrl, secret, 'near_recheck'), AUTO_AI_NEAR_QUALIFIED_RECHECK_INTERVAL_MS));
  addTimer(setInterval(() => void tickAllEngineWatches(nextUrl, secret, 'hot_watch'), AUTO_AI_HOT_TRIGGER_WATCH_INTERVAL_MS));
  addTimer(setInterval(() => void activeTradeManagementTick(nextUrl, secret), ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS));
  addTimer(setInterval(() => void transactionSyncTick(nextUrl, secret), OANDA_TRANSACTION_SYNC_INTERVAL_MS));
  addTimer(setInterval(() => void dailyMarketStudyTick(nextUrl, secret), DAILY_MARKET_STUDY_INTERVAL_MS));

  void tick(nextUrl, secret, { scanMode: 'full', pairs: [], engine: null, logTag: '[AUTO_AI][STARTUP]' });
  // Do not run active management immediately on process startup. The first close-capable review must occur on the 30-minute scheduler cadence.
  void transactionSyncTick(nextUrl, secret);
  void dailyMarketStudyTick(nextUrl, secret);
  return {
    started: true,
    fullScanMs: full,
    nearRecheckMs: AUTO_AI_NEAR_QUALIFIED_RECHECK_INTERVAL_MS,
    hotWatchMs: AUTO_AI_HOT_TRIGGER_WATCH_INTERVAL_MS,
    managementMs: ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS,
    dailyStudyMs: DAILY_MARKET_STUDY_INTERVAL_MS,
  };
}

async function tickAllEngineWatches(nextUrl, secret, scanMode) {
  const watchKey = scanMode === 'hot_watch' ? 'hotPairs' : 'nearQualifiedPairs';
  const results = [];
  for (const engine of AUTO_ENGINES) {
    const pairs = [...engineWatchStates[engine][watchKey]];
    const logTag = `[AUTO_AI][${scanMode === 'hot_watch' ? 'HOT' : 'NEAR'}][${engine.toUpperCase()}]`;
    results.push(await tick(nextUrl, secret, { scanMode, pairs, engine, logTag }));
  }
  return results;
}

export async function tick(nextUrl, secret, options = {}) {
  const { scanMode = 'full', pairs = [], engine = null, logTag = '[AUTO_AI]' } = options;
  if (!inAutoAiWindow()) return { ok: true, skipped: true, reason: 'outside_scan_window' };
  if ((scanMode === 'near_recheck' || scanMode === 'hot_watch') && (!engine || !pairs.length)) {
    return { ok: true, skipped: true, reason: !engine ? 'engine_required' : 'no_pairs' };
  }
  const runId = makeRunId();
  const result = await post(nextUrl, secret, '/api/cron/auto-ai-trading-extended', {
    source: 'railway-scheduler', runId, scanMode, pairs, engine,
  }, `${logTag}[runId=${runId}]`);
  if (result.ok) updateWatchStateFromCronResponse(result.body, logTag, scanMode, pairs, engine);
  return result;
}

async function activeTradeManagementTick(nextUrl, secret) {
  if (!inActiveTradeManagementWindow()) return { ok: true, skipped: true, reason: 'outside_management_window' };
  return post(nextUrl, secret, '/api/cron/active-trade-management', {
    source: 'railway-scheduler', runId: makeRunId(),
  }, '[ACTIVE_TRADE_MANAGEMENT]');
}

async function transactionSyncTick(nextUrl, secret) {
  return post(nextUrl, secret, '/api/cron/oanda-transaction-sync', { source: 'railway-scheduler' }, '[OANDA_TX_SYNC]');
}

function newYorkDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

export async function dailyMarketStudyTick(nextUrl, secret, now = new Date()) {
  if (!inDailyMarketStudyWindow(now)) {
    return { ok: true, skipped: true, reason: 'outside_daily_market_study_window' };
  }
  const dayKey = newYorkDateKey(now);
  if (lastDailyStudyDateKey === dayKey) {
    return { ok: true, skipped: true, reason: 'daily_market_study_already_completed', dayKey };
  }
  const results = [];
  for (const engine of ['ict', 'ppr']) {
    const runId = makeRunId();
    results.push(await post(nextUrl, secret, '/api/cron/auto-ai-trading-extended', {
      source: 'railway-scheduler', runId, scanMode: 'daily_study', pairs: [], engine,
    }, `[DAILY_STUDY][${engine.toUpperCase()}][runId=${runId}]`));
  }
  const ok = results.every((result) => result.ok);
  if (ok) lastDailyStudyDateKey = dayKey;
  return { ok, dayKey, results };
}

function applyReturnedWatchState(engine, returned, scanMode, scannedPairs) {
  const state = engineWatchStates[engine];
  if (!state) return;
  const near = normalize(returned?.nearQualifiedPairs);
  const hot = normalize(returned?.hotPairs);
  const late = normalize(returned?.lateEntryPairs);

  if (scanMode === 'full') {
    clearEngineWatchState(engine);
  } else {
    for (const pair of normalize(scannedPairs)) {
      state.nearQualifiedPairs.delete(pair);
      state.hotPairs.delete(pair);
    }
  }
  for (const pair of near) state.nearQualifiedPairs.add(pair);
  for (const pair of hot) state.hotPairs.add(pair);
  for (const pair of late) {
    state.nearQualifiedPairs.delete(pair);
    state.hotPairs.delete(pair);
  }
}

export function updateWatchStateFromCronResponse(text, tag, scanMode = 'full', scannedPairs = [], engine = null) {
  let data;
  try { data = JSON.parse(text); } catch { return; }

  if (engine) {
    const returned = data?.engineWatchStates?.[engine] || data;
    applyReturnedWatchState(engine, returned, scanMode, scannedPairs);
  } else if (data?.engineWatchStates && typeof data.engineWatchStates === 'object') {
    for (const currentEngine of AUTO_ENGINES) {
      applyReturnedWatchState(currentEngine, data.engineWatchStates[currentEngine] || {}, scanMode, []);
    }
  } else {
    // Backward-compatible fallback for an old aggregate response. Keep it scoped
    // to ICT rather than contaminating every engine watchlist.
    applyReturnedWatchState('ict', data, scanMode, scannedPairs);
  }

  console.log(`${tag} engineWatchStates=${JSON.stringify(serializedEngineWatchStates())}`);
}

export function stopAutoAiScheduler() {
  const stopped = timers.length > 0;
  for (const timer of timers) clearInterval(timer);
  timers = [];
  for (const engine of AUTO_ENGINES) clearEngineWatchState(engine);
  return stopped ? { stopped: true } : { stopped: false, reason: 'not_running' };
}

export function getNewYorkMinutes(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const hour = get('hour') === 24 ? 0 : get('hour');
  return hour * 60 + get('minute');
}
export function getNewYorkHour(date = new Date()) { return Math.floor(getNewYorkMinutes(date) / 60); }
export function isPrimaryTradeWindow(date = new Date()) { return inAutoAiWindow(date); }
export function isTrueHardReject(reason = '') {
  const r = String(reason).toLowerCase();
  return (r.includes('rr') && r.includes('1.5')) || (r.includes('risk reward') && r.includes('below')) ||
    r.includes('max daily loss') || r.includes('daily loss') || r.includes('max trades') || r.includes('duplicate') ||
    r.includes('spread too high') || r.includes('invalid broker') || r.includes('credentials') ||
    r.includes('missing stop') || r.includes('missing take profit') || r.includes('live trading disabled') || r.includes('execution disabled');
}
export function softenRejectReasons(reasons = [], now = new Date()) {
  if (!isPrimaryTradeWindow(now)) return reasons;
  return reasons.filter((reason) => {
    const r = String(reason).toLowerCase();
    if (isTrueHardReject(r)) return true;
    return !['late_entry','late entry','flow opposes','institutional flow','missing smt','missing fvg','mixed ema','emaalignment=mixed','single opposing liquidity','liquidity proxy'].some((text) => r.includes(text));
  });
}
export function pickTradeMode(candidate = {}) {
  const rr = Number(candidate.rr ?? candidate.riskReward ?? candidate.expectedRR ?? 0);
  const confidence = Number(candidate.confidence ?? candidate.score ?? 0);
  return rr >= 1.5 && confidence >= 85 ? 'SCALP' : 'NONE';
}
export function prioritizeRetraceWatchPairs(pairs = []) { return [...new Set([...getRetraceWatchPairs(), ...pairs])]; }
