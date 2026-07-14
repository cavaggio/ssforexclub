import { getRetraceWatchPairs, evaluateRetraceCandidate } from './retraceWatchMode.js';
/**
 * server/ictAutoScheduler.js
 *
 * Railway-side staged trigger for autonomous Auto AI trading. It does NOT
 * resolve credentials or execute itself — Railway has no Clerk/decrypt context.
 * Each in-window tick POSTs protected Next endpoints, which enumerate opted-in
 * users, resolve each user's credentials, and call the Railway internal OANDA
 * endpoints with a user-scoped client.
 *
 * Off by default (ICT_AUTO_AI_SCHEDULER_ENABLED=false).
 *
 * Cadence:
 * - Full entry scan: every 2 minutes, 02:15–14:00 ET weekdays
 * - Near-qualified recheck: every 60 seconds, 02:15–14:00 ET weekdays
 * - Hot trigger watch: every 30 seconds, 02:15–14:00 ET weekdays
 * - Active-trade management: every 5 minutes, 02:15–17:05 ET weekdays
 */

import { etParts } from './ictTime.js';

export const AUTO_AI_WINDOW = { startMin: 2 * 60 + 15, endMin: 14 * 60 }; // 02:15–14:00 ET
export const ACTIVE_TRADE_MANAGEMENT_WINDOW = {
  startMin: 2 * 60 + 15,
  endMin: 17 * 60 + 5,
}; // final 17:00 ET sweep plus five-minute scheduling grace

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

function parseInterval(name, fallbackMs) {
  const raw = process.env[name];
  const parsed = Number.parseInt(raw || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

/** True only on a NY weekday within the Auto AI entry window. */
export function inAutoAiWindow(input = new Date()) {
  const et = etParts(input);
  if (!et || et.isWeekend) return false;
  return et.minutesFromMidnight >= AUTO_AI_WINDOW.startMin && et.minutesFromMidnight < AUTO_AI_WINDOW.endMin;
}

/** True while account-scoped active-trade monitoring is allowed. */
export function inActiveTradeManagementWindow(input = new Date()) {
  const et = etParts(input);
  if (!et || et.isWeekend) return false;
  return (
    et.minutesFromMidnight >= ACTIVE_TRADE_MANAGEMENT_WINDOW.startMin &&
    et.minutesFromMidnight < ACTIVE_TRADE_MANAGEMENT_WINDOW.endMin
  );
}

/** Short correlation id for one scheduler tick, threaded through the whole path. */
export function makeRunId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Exposed for tests/debugging. */
export function getAutoAiWatchState() {
  return {
    nearQualifiedPairs: Array.from(nearQualifiedPairs),
    hotPairs: Array.from(hotPairs),
    runningTimers: _timers.length,
  };
}

export function startAutoAiScheduler({ intervalMs = AUTO_AI_FULL_SCAN_INTERVAL_MS } = {}) {
  if (String(process.env.ICT_AUTO_AI_SCHEDULER_ENABLED || 'false').toLowerCase() !== 'true') {
    console.log('[AUTO_AI] ICT_AUTO_AI_SCHEDULER_ENABLED!=true — scheduler not started');
    return { started: false, reason: 'disabled_by_env' };
  }

  if (_timers.length) {
    console.log('[AUTO_AI] scheduler already running — skipping duplicate start');
    return { started: false, reason: 'already_running' };
  }

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
  const activeTradeManagementMs = ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS;

  console.log(
    `[AUTO_AI] starting staged scheduler → ${nextUrl}/api/cron/auto-ai-trading ` +
    `(NY weekday entries 02:15–14:00 ET; full=${fullScanMs}ms near=${nearRecheckMs}ms hot=${hotWatchMs}ms; ` +
    `active-management 02:15–17:05 ET every ${activeTradeManagementMs}ms)`,
  );

  addTimer(setInterval(() => {
    void tick(nextUrl, secret, {
      scanMode: 'full',
      pairs: [],
      logTag: '[AUTO_AI][FULL_SCAN]',
    });
  }, fullScanMs));

  addTimer(setInterval(() => {
    void tick(nextUrl, secret, {
      scanMode: 'near_recheck',
      pairs: Array.from(nearQualifiedPairs),
      logTag: '[AUTO_AI][NEAR_RECHECK]',
    });
  }, nearRecheckMs));

  addTimer(setInterval(() => {
    void tick(nextUrl, secret, {
      scanMode: 'hot_watch',
      pairs: Array.from(hotPairs),
      logTag: '[AUTO_AI][HOT_WATCH]',
    });
  }, hotWatchMs));

  addTimer(setInterval(() => {
    void activeTradeManagementTick(nextUrl, secret);
  }, activeTradeManagementMs));
  void activeTradeManagementTick(nextUrl, secret);

  // Sync broker-side OANDA TP/SL closes into trade_logs for Edge Intelligence.
  // This is intentionally NOT gated by the Auto AI entry window.
  addTimer(setInterval(() => {
    void transactionSyncTick(nextUrl, secret);
  }, OANDA_TRANSACTION_SYNC_INTERVAL_MS));
  void transactionSyncTick(nextUrl, secret);

  return {
    started: true,
    intervalMs: fullScanMs,
    fullScanMs,
    nearRecheckMs,
    hotWatchMs,
    activeTradeManagementMs,
  };
}

function addTimer(timer) {
  if (typeof timer.unref === 'function') timer.unref();
  _timers.push(timer);
}

export async function tick(nextUrl, secret, options = {}) {
  const {
    scanMode = 'full',
    pairs = [],
    logTag = '[AUTO_AI][FULL_SCAN]',
  } = options;

  if (!inAutoAiWindow(new Date())) {
    console.log(`${logTag} outside Auto AI entry window (02:15–14:00 ET) — skip`);
    return { ok: true, skipped: true, reason: 'outside_entry_window' };
  }

  if ((scanMode === 'near_recheck' || scanMode === 'hot_watch') && !pairs.length) {
    console.log(`${logTag} no pairs to check — skip`);
    return { ok: true, skipped: true, reason: 'no_pairs' };
  }

  const runId = makeRunId();
  const tag = `${logTag}[runId=${runId}]`;
  const cronUrl = `${String(nextUrl).replace(/\/$/, '')}/api/cron/auto-ai-trading`;

  console.log(`${tag} scan started scanMode=${scanMode} pairs=${pairs.length ? pairs.join(',') : 'ALL'}`);
  console.log(`${logTag} cronUrl=${cronUrl}`);

  try {
    const res = await fetch(cronUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cron-Secret': secret,
      },
      body: JSON.stringify({
        source: 'railway-scheduler',
        runId,
        scanMode,
        pairs,
      }),
    });

    const text = await res.text();

    if (!res.ok) {
      console.log(`${tag} cron call failed ${res.status}: ${text.slice(0, 300)}`);
      return { ok: false, status: res.status, body: text };
    }

    updateWatchStateFromCronResponse(text, tag, scanMode, pairs);

    console.log(`${tag} complete ${text.slice(0, 300)}`);
    return { ok: true, status: res.status, body: text };
  } catch (err) {
    console.log(`${tag} cron unreachable: ${err?.message || err}`);
    return { ok: false, error: err?.message || String(err) };
  }
}

export async function activeTradeManagementTick(nextUrl, secret, now = new Date()) {
  const tag = '[AUTO_AI_ACTIVE_MANAGEMENT][SCHEDULER]';

  if (!inActiveTradeManagementWindow(now)) {
    console.log(`${tag} outside 02:15–17:05 ET management window — skip`);
    return { ok: true, skipped: true, reason: 'outside_management_window' };
  }

  const managementUrl = `${String(nextUrl).replace(/\/$/, '')}/api/cron/oanda-active-trade-management`;

  try {
    const res = await fetch(managementUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cron-Secret': secret,
      },
      body: JSON.stringify({ source: 'railway-scheduler', runId: makeRunId() }),
    });

    const text = await res.text();

    if (!res.ok) {
      console.log(`${tag} failed ${res.status}: ${text.slice(0, 500)}`);
      return { ok: false, status: res.status, body: text };
    }

    console.log(`${tag} complete ${text.slice(0, 500)}`);
    return { ok: true, status: res.status, body: text };
  } catch (err) {
    console.log(`${tag} unreachable: ${err?.message || err}`);
    return { ok: false, error: err?.message || String(err) };
  }
}

async function transactionSyncTick(nextUrl, secret) {
  const syncUrl = `${String(nextUrl).replace(/\/$/, '')}/api/cron/oanda-transaction-sync`;
  const tag = '[OANDA_TX_SYNC][SCHEDULER]';

  try {
    const res = await fetch(syncUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cron-Secret': secret,
      },
      body: JSON.stringify({ source: 'railway-scheduler' }),
    });

    const text = await res.text();

    if (!res.ok) {
      console.log(`${tag} failed ${res.status}: ${text.slice(0, 300)}`);
      return { ok: false, status: res.status, body: text };
    }

    console.log(`${tag} complete ${text.slice(0, 300)}`);
    return { ok: true, status: res.status, body: text };
  } catch (err) {
    console.log(`${tag} unreachable: ${err?.message || err}`);
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

/**
 * A full scan is authoritative for the whole watchlist and replaces both sets.
 * A staged scan is authoritative only for the pairs it actually reviewed, so it
 * must not erase unrelated hot/near candidates discovered by another cadence.
 */
export function updateWatchStateFromCronResponse(text, tag, scanMode = 'full', scannedPairs = []) {
  let json = null;

  try {
    json = JSON.parse(text);
  } catch {
    return;
  }

  const returnedNear = Array.isArray(json.nearQualifiedPairs) ? json.nearQualifiedPairs : [];
  const returnedHot = Array.isArray(json.hotPairs) ? json.hotPairs : [];

  if (scanMode === 'full') {
    replaceWatchSet(nearQualifiedPairs, returnedNear);
    replaceWatchSet(hotPairs, returnedHot);
  } else {
    reconcileScopedWatchSet(nearQualifiedPairs, scannedPairs, returnedNear);
    reconcileScopedWatchSet(hotPairs, scannedPairs, returnedHot);
  }

  console.log(`${tag} updated nearQualifiedPairs=${Array.from(nearQualifiedPairs).join(',') || 'none'}`);
  console.log(`${tag} updated hotPairs=${Array.from(hotPairs).join(',') || 'none'}`);

  if (Array.isArray(json.lateEntryPairs)) {
    for (const pair of json.lateEntryPairs) {
      const normalized = String(pair).trim();
      if (!normalized) continue;

      nearQualifiedPairs.delete(normalized);
      hotPairs.delete(normalized);

      console.log(`[AUTO_AI][LATE_ENTRY_BLOCK] pair=${normalized} removed from near/hot watch`);
    }
  }
}

export function stopAutoAiScheduler() {
  if (!_timers.length) {
    nearQualifiedPairs.clear();
    hotPairs.clear();
    return { stopped: false, reason: 'not_running' };
  }

  for (const timer of _timers) {
    clearInterval(timer);
  }

  _timers = [];
  nearQualifiedPairs.clear();
  hotPairs.clear();

  return { stopped: true };
}

// === ACTIVE TRADE LOGIC PATCH ===
export function getNewYorkMinutes(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);

  const hour = get('hour') === 24 ? 0 : get('hour');
  return hour * 60 + get('minute');
}

export function getNewYorkHour(date = new Date()) {
  return Math.floor(getNewYorkMinutes(date) / 60);
}

export function isPrimaryTradeWindow(date = new Date()) {
  const minutes = getNewYorkMinutes(date);
  return minutes >= 2 * 60 + 15 && minutes < 14 * 60;
}

export function isTrueHardReject(reason = '') {
  const r = String(reason).toLowerCase();
  return (
    r.includes('rr') && r.includes('1.5') ||
    r.includes('risk reward') && r.includes('below') ||
    r.includes('max daily loss') ||
    r.includes('daily loss') ||
    r.includes('max trades') ||
    r.includes('duplicate') ||
    r.includes('spread too high') ||
    r.includes('invalid broker') ||
    r.includes('credentials') ||
    r.includes('missing stop') ||
    r.includes('missing take profit') ||
    r.includes('live trading disabled') ||
    r.includes('execution disabled')
  );
}

export function softenRejectReasons(reasons = [], now = new Date()) {
  if (!isPrimaryTradeWindow(now)) return reasons;

  return reasons.filter((reason) => {
    const r = String(reason).toLowerCase();

    if (isTrueHardReject(r)) return true;

    if (
      r.includes('late_entry') ||
      r.includes('late entry') ||
      r.includes('flow opposes') ||
      r.includes('institutional flow') ||
      r.includes('missing smt') ||
      r.includes('missing fvg') ||
      r.includes('mixed ema') ||
      r.includes('emaalignment=mixed') ||
      r.includes('single opposing liquidity') ||
      r.includes('liquidity proxy')
    ) {
      return false;
    }

    return true;
  });
}

export function pickTradeMode(candidate = {}) {
  const rr = Number(candidate.rr ?? candidate.riskReward ?? candidate.expectedRR ?? 0);
  const confidence = Number(candidate.confidence ?? candidate.score ?? 0);

  if (rr >= 1.5 && confidence >= 85) return 'SCALP';
  return 'NONE';
}
// === END ACTIVE TRADE LOGIC PATCH ===

function prioritizeRetraceWatchPairs(pairs = []) {
  const watched = getRetraceWatchPairs();
  return [...new Set([...watched, ...pairs])];
}
