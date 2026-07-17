import { getRetraceWatchPairs } from './retraceWatchMode.js';
import { etParts } from './ictTime.js';

export const AUTO_AI_WINDOW = { startMin: 120, endMin: 600 }; // 02:00–10:00 ET, Monday–Friday
export const ACTIVE_TRADE_MANAGEMENT_WINDOW = { startMin: 600, endMin: 1050 }; // 10:00–17:30 ET, Monday–Friday

function interval(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const AUTO_AI_FULL_SCAN_INTERVAL_MS = interval('AUTO_AI_FULL_SCAN_INTERVAL_MS', 120000);
export const AUTO_AI_NEAR_QUALIFIED_RECHECK_INTERVAL_MS = interval('AUTO_AI_NEAR_QUALIFIED_RECHECK_INTERVAL_MS', 60000);
export const AUTO_AI_HOT_TRIGGER_WATCH_INTERVAL_MS = interval('AUTO_AI_HOT_TRIGGER_WATCH_INTERVAL_MS', 30000);
export const ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS = interval('ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS', 300000);
export const OANDA_TRANSACTION_SYNC_INTERVAL_MS = interval('OANDA_TRANSACTION_SYNC_INTERVAL_MS', 1800000);

const nearQualifiedPairs = new Set();
const hotPairs = new Set();
let timers = [];

function inWindow(date, window) {
  const et = etParts(date);
  return Boolean(et && !et.isWeekend && et.minutesFromMidnight >= window.startMin && et.minutesFromMidnight < window.endMin);
}
export function inAutoAiWindow(date = new Date()) { return inWindow(date, AUTO_AI_WINDOW); }
export function inActiveTradeManagementWindow(date = new Date()) { return inWindow(date, ACTIVE_TRADE_MANAGEMENT_WINDOW); }
export function makeRunId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
export function getAutoAiWatchState() {
  return { nearQualifiedPairs: [...nearQualifiedPairs], hotPairs: [...hotPairs], runningTimers: timers.length };
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
    `[AUTO_AI] entries=02:00–10:00_ET weekdays_only full=${full}ms near=${AUTO_AI_NEAR_QUALIFIED_RECHECK_INTERVAL_MS}ms ` +
    `hot=${AUTO_AI_HOT_TRIGGER_WATCH_INTERVAL_MS}ms management=10:00–17:30_ET weekdays_only/${ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS}ms`,
  );

  addTimer(setInterval(() => void tick(nextUrl, secret, { scanMode: 'full', pairs: [], logTag: '[AUTO_AI][FULL]' }), full));
  addTimer(setInterval(() => void tick(nextUrl, secret, { scanMode: 'near_recheck', pairs: [...nearQualifiedPairs], logTag: '[AUTO_AI][NEAR]' }), AUTO_AI_NEAR_QUALIFIED_RECHECK_INTERVAL_MS));
  addTimer(setInterval(() => void tick(nextUrl, secret, { scanMode: 'hot_watch', pairs: [...hotPairs], logTag: '[AUTO_AI][HOT]' }), AUTO_AI_HOT_TRIGGER_WATCH_INTERVAL_MS));
  addTimer(setInterval(() => void activeTradeManagementTick(nextUrl, secret), ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS));
  addTimer(setInterval(() => void transactionSyncTick(nextUrl, secret), OANDA_TRANSACTION_SYNC_INTERVAL_MS));

  void tick(nextUrl, secret, { scanMode: 'full', pairs: [], logTag: '[AUTO_AI][STARTUP]' });
  void activeTradeManagementTick(nextUrl, secret);
  void transactionSyncTick(nextUrl, secret);
  return { started: true, fullScanMs: full, nearRecheckMs: 60000, hotWatchMs: 30000, managementMs: ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS };
}

export async function tick(nextUrl, secret, options = {}) {
  const { scanMode = 'full', pairs = [], logTag = '[AUTO_AI]' } = options;
  if (!inAutoAiWindow()) return { ok: true, skipped: true, reason: 'outside_entry_window' };
  if ((scanMode === 'near_recheck' || scanMode === 'hot_watch') && !pairs.length) {
    return { ok: true, skipped: true, reason: 'no_pairs' };
  }
  const runId = makeRunId();
  const result = await post(nextUrl, secret, '/api/cron/auto-ai-trading-extended', {
    source: 'railway-scheduler', runId, scanMode, pairs,
  }, `${logTag}[runId=${runId}]`);
  if (result.ok) updateWatchStateFromCronResponse(result.body, logTag, scanMode, pairs);
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

function normalize(value) {
  return Array.isArray(value) ? [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))] : [];
}
export function updateWatchStateFromCronResponse(text, tag, scanMode = 'full', scannedPairs = []) {
  let data;
  try { data = JSON.parse(text); } catch { return; }
  const near = normalize(data.nearQualifiedPairs);
  const hot = normalize(data.hotPairs);
  if (scanMode === 'full') {
    nearQualifiedPairs.clear(); hotPairs.clear();
  } else {
    for (const pair of normalize(scannedPairs)) { nearQualifiedPairs.delete(pair); hotPairs.delete(pair); }
  }
  for (const pair of near) nearQualifiedPairs.add(pair);
  for (const pair of hot) hotPairs.add(pair);
  for (const pair of normalize(data.lateEntryPairs)) { nearQualifiedPairs.delete(pair); hotPairs.delete(pair); }
  console.log(`${tag} near=${[...nearQualifiedPairs].join(',') || 'none'} hot=${[...hotPairs].join(',') || 'none'}`);
}

export function stopAutoAiScheduler() {
  const stopped = timers.length > 0;
  for (const timer of timers) clearInterval(timer);
  timers = [];
  nearQualifiedPairs.clear();
  hotPairs.clear();
  return stopped ? { stopped: true } : { stopped: false, reason: 'not_running' };
}

export function getNewYorkMinutes(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const hour = get('hour') === 24 ? 0 : get('hour');
  return hour * 60 + get('minute');
}
export function getNewYorkHour(date = new Date()) { return Math.floor(getNewYorkMinutes(date) / 60); }
export function isPrimaryTradeWindow(date = new Date()) {
  return inAutoAiWindow(date);
}
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
