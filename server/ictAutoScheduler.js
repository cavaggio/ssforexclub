import { getRetraceWatchPairs } from './retraceWatchMode.js';
import { etParts } from './ictTime.js';

/**
 * Railway-side scheduler.
 * New entries: NY weekdays 02:15–14:00 ET.
 * Active-trade management: NY weekdays 14:00–17:30 ET.
 * Full scan: 2 minutes; near: 60 seconds; hot: 30 seconds.
 */
export const AUTO_AI_WINDOW = { startMin: 2 * 60 + 15, endMin: 14 * 60 };
export const ACTIVE_TRADE_MANAGEMENT_WINDOW = { startMin: 14 * 60, endMin: 17 * 60 + 30 };

function parseInterval(name, fallbackMs) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

export const AUTO_AI_FULL_SCAN_INTERVAL_MS = parseInterval(
  'AUTO_AI_FULL_SCAN_INTERVAL_MS',
  2 * 60 * 1000,
);
export const AUTO_AI_NEAR_QUALIFIED_RECHECK_INTERVAL_MS = parseInterval(
  'AUTO_AI_NEAR_QUALIFIED_RECHECK_INTERVAL_MS',
  60 * 1000,
);
export const AUTO_AI_HOT_TRIGGER_WATCH_INTERVAL_MS = parseInterval(
  'AUTO_AI_HOT_TRIGGER_WATCH_INTERVAL_MS',
  30 * 1000,
);
export const ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS = parseInterval(
  'ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS',
  5 * 60 * 1000,
);
export const OANDA_TRANSACTION_SYNC_INTERVAL_MS = parseInterval(
  'OANDA_TRANSACTION_SYNC_INTERVAL_MS',
  30 * 60 * 1000,
);

const nearQualifiedPairs = new Set();
const hotPairs = new Set();
let _timers = [];

export function inAutoAiWindow(input = new Date()) {
  const et = etParts(input);
  if (!et || et.isWeekend) return false;
  return et.minutesFromMidnight >= AUTO_AI_WINDOW.startMin && et.minutesFromMidnight < AUTO_AI_WINDOW.endMin;
}

export function inActiveTradeManagementWindow(input = new Date()) {
  const et = etParts(input);
  if (!et || et.isWeekend) return false;
  return et.minutesFromMidnight >= ACTIVE_TRADE_MANAGEMENT_WINDOW.startMin &&
    et.minutesFromMidnight < ACTIVE_TRADE_MANAGEMENT_WINDOW.endMin;
}

export function makeRunId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getAutoAiWatchState() {
  return {
    nearQualifiedPairs: Array.from(nearQualifiedPairs),
    hotPairs: Array.from(hotPairs),
    runningTimers: _timers.length,
  };
}

function addTimer(timer) {
  if (typeof timer.unref === 'function') timer.unref();
  _timers.push(timer);
}

export function startAutoAiScheduler({ intervalMs = AUTO_AI_FULL_SCAN_INTERVAL_MS } = {}) {
  if (String(process.env.ICT_AUTO_AI_SCHEDULER_ENABLED || 'true').toLowerCase() !== 'true') {
    console.log('[AUTO_AI] ICT_AUTO_AI_SCHEDULER_ENABLED!=true — scheduler not started');
    return { started: false, reason: 'disabled_by_env' };
  }
  if (_timers.length) return { started: false, reason: 'already_running' };

  const nextUrl = process.env.NEXT_BASE_URL;
  const secret = process.env.AUTO_AI_CRON_SECRET;
  if (!nextUrl || !secret) {
    console.log('[AUTO_AI] NEXT_BASE_URL / AUTO_AI_CRON_SECRET not set — scheduler not started');
    return { started: false, reason: 'missing_config' };
  }

  const fullScanMs = Number.isFinite(Number(intervalMs)) && Number(intervalMs) > 0
    ? Number(intervalMs)
    : AUTO_AI_FULL_SCAN_INTERVAL_MS;
  const nearRecheckMs = AUTO_AI_NEAR_QUALIFIED_RECHECK_INTERVAL_MS;
  const hotWatchMs = AUTO_AI_HOT_TRIGGER_WATCH_INTERVAL_MS;
  const managementMs = ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS;

  console.log(
    `[AUTO_AI] starting staged scheduler → ${nextUrl}/api/cron/auto-ai-trading ` +
    `(NY weekday 02:15–14:00 ET; full=${fullScanMs}ms near=${nearRecheckMs}ms hot=${hotWatchMs}ms; ` +
    `management=14:00–17:30 ET/${managementMs}ms)`,
  );

  addTimer(setInterval(() => void tick(nextUrl, secret, {
    scanMode: 'full', pairs: [], logTag: '[AUTO_AI][FULL_SCAN]',
  }), fullScanMs));
  addTimer(setInterval(() => void tick(nextUrl, secret, {
    scanMode: 'near_recheck', pairs: Array.from(nearQualifiedPairs), logTag: '[AUTO_AI][NEAR_RECHECK]',
  }), nearRecheckMs));
  addTimer(setInterval(() => void tick(nextUrl, secret, {
    scanMode: 'hot_watch', pairs: Array.from(hotPairs), logTag: '[AUTO_AI][HOT_WATCH]',
  }), hotWatchMs));
  addTimer(setInterval(() => void activeTradeManagementTick(nextUrl, secret), managementMs));
  addTimer(setInterval(() => void transactionSyncTick(nextUrl, secret), OANDA_TRANSACTION_SYNC_INTERVAL_MS));

  void tick(nextUrl, secret, { scanMode: 'full', pairs: [], logTag: '[AUTO_AI][FULL_SCAN][STARTUP]' });
  void activeTradeManagementTick(nextUrl, secret);
  void transactionSyncTick(nextUrl, secret);

  return { started: true, fullScanMs, nearRecheckMs, hotWatchMs, managementMs };
}

export async function tick(nextUrl, secret, options = {}) {
  const { scanMode = 'full', pairs = [], logTag = '[AUTO_AI][FULL_SCAN]' } = options;
  if (!inAutoAiWindow(new Date())) {
    console.log(`${logTag} outside Auto AI entry window — skip`);
    return { ok: true, skipped: true, reason: 'outside_window' };
  }
  if ((scanMode === 'near_recheck' || scanMode === 'hot_watch') && !pairs.length) {
    return { ok: true, skipped: true, reason: 'no_pairs' };
  }

  const runId = makeRunId();
  const tag = `${logTag}[runId=${runId}]`;
  const cronUrl = `${String(nextUrl).replace(/\/$/, '')}/api/cron/auto-ai-trading`;
  try {
    const res = await fetch(cronUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cron-Secret': secret },
      body: JSON.stringify({ source: 'railway-scheduler', runId, scanMode, pairs }),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, body: text };
    updateWatchStateFromCronResponse(text, tag, scanMode, pairs);
    console.log(`${tag} complete ${text.slice(0, 300)}`);
    return { ok: true, status: res.status, body: text };
  } catch (err) {
    console.log(`${tag} cron unreachable: ${err?.message || err}`);
    return { ok: false, error: err?.message || String(err) };
  }
}

async function activeTradeManagementTick(nextUrl, secret) {
  if (!inActiveTradeManagementWindow(new Date())) {
    return { ok: true, skipped: true, reason: 'outside_management_window' };
  }
  const url = `${String(nextUrl).replace(/\/$/, '')}/api/cron/active-trade-management`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cron-Secret': secret },
      body: JSON.stringify({ source: 'railway-scheduler', runId: makeRunId() }),
    });
    const text = await res.text();
    console.log(`[ACTIVE_TRADE_MANAGEMENT] status=${res.status} ${text.slice(0, 300)}`);
    return { ok: res.ok, status: res.status, body: text };
  } catch (err) {
    console.log(`[ACTIVE_TRADE_MANAGEMENT] unreachable: ${err?.message || err}`);
    return { ok: false, error: err?.message || String(err) };
  }
}

async function transactionSyncTick(nextUrl, secret) {
  const url = `${String(nextUrl).replace(/\/$/, '')}/api/cron/oanda-transaction-sync`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cron-Secret': secret },
      body: JSON.stringify({ source: 'railway-scheduler' }),
    });
    return { ok: res.ok, status: res.status, body: await res.text() };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function normalizePairList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((pair) => String(pair || '').trim()).filter(Boolean))];
}
function replaceWatchSet(target, values) {
  target.clear();
  for (const pair of normalizePairList(values)) target.add(pair);
}
function reconcileScopedWatchSet(target, scannedPairs, returnedPairs) {
  for (const pair of normalizePairList(scannedPairs)) target.delete(pair);
  for (const pair of normalizePairList(returnedPairs)) target.add(pair);
}

export function updateWatchStateFromCronResponse(text, tag, scanMode = 'full', scannedPairs = []) {
  let json;
  try { json = JSON.parse(text); } catch { return; }
  const returnedNear = Array.isArray(json.nearQualifiedPairs) ? json.nearQualifiedPairs : [];
  const returnedHot = Array.isArray(json.hotPairs) ? json.hotPairs : [];
  if (scanMode === 'full') {
    replaceWatchSet(nearQualifiedPairs, returnedNear);
    replaceWatchSet(hotPairs, returnedHot);
  } else {
    reconcileScopedWatchSet(nearQualifiedPairs, scannedPairs, returnedNear);
    reconcileScopedWatchSet(hotPairs, scannedPairs, returnedHot);
  }
  if (Array.isArray(json.lateEntryPairs)) {
    for (const pair of json.lateEntryPairs) {
      nearQualifiedPairs.delete(String(pair).trim());
      hotPairs.delete(String(pair).trim());
    }
  }
  console.log(`${tag} near=${Array.from(nearQualifiedPairs).join(',') || 'none'} hot=${Array.from(hotPairs).join(',') || 'none'}`);
}

export function stopAutoAiScheduler() {
  for (const timer of _timers) clearInterval(timer);
  const stopped = _timers.length > 0;
  _timers = [];
  nearQualifiedPairs.clear();
  hotPairs.clear();
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
export function isPrimaryTradeWindow(date = new Date()) {
  const minutes = getNewYorkMinutes(date);
  return minutes >= AUTO_AI_WINDOW.startMin && minutes < AUTO_AI_WINDOW.endMin;
}
export function isTrueHardReject(reason = '') {
  const r = String(reason).toLowerCase();
  return (r.includes('rr') && r.includes('1.5')) ||
    (r.includes('risk reward') && r.includes('below')) ||
    r.includes('max daily loss') || r.includes('daily loss') || r.includes('max trades') ||
    r.includes('duplicate') || r.includes('spread too high') || r.includes('invalid broker') ||
    r.includes('credentials') || r.includes('missing stop') || r.includes('missing take profit') ||
    r.includes('live trading disabled') || r.includes('execution disabled');
}
export function softenRejectReasons(reasons = [], now = new Date()) {
  if (!isPrimaryTradeWindow(now)) return reasons;
  return reasons.filter((reason) => {
    const r = String(reason).toLowerCase();
    if (isTrueHardReject(r)) return true;
    return !(
      r.includes('late_entry') || r.includes('late entry') || r.includes('flow opposes') ||
      r.includes('institutional flow') || r.includes('missing smt') || r.includes('missing fvg') ||
      r.includes('mixed ema') || r.includes('emaalignment=mixed') ||
      r.includes('single opposing liquidity') || r.includes('liquidity proxy')
    );
  });
}
export function pickTradeMode(candidate = {}) {
  const rr = Number(candidate.rr ?? candidate.riskReward ?? candidate.expectedRR ?? 0);
  const confidence = Number(candidate.confidence ?? candidate.score ?? 0);
  return rr >= 1.5 && confidence >= 85 ? 'SCALP' : 'NONE';
}
export function prioritizeRetraceWatchPairs(pairs = []) {
  return [...new Set([...getRetraceWatchPairs(), ...pairs])];
}
