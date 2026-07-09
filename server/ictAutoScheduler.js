import { getRetraceWatchPairs, evaluateRetraceCandidate } from './retraceWatchMode.js';
/**
 * server/ictAutoScheduler.js
 *
 * Railway-side staged trigger for autonomous Auto AI trading. It does NOT
 * resolve credentials or execute itself — Railway has no Clerk/decrypt context.
 * Each in-window tick POSTs a protected Next endpoint
 * (/api/cron/auto-ai-trading), which enumerates opted-in users, resolves each
 * user's creds, and calls back into the Railway internal Auto AI endpoints.
 *
 * Off by default (ICT_AUTO_AI_SCHEDULER_ENABLED=false). Only fires on NY
 * weekdays between 02:15 and 14:00 ET (DST-aware via ictTime).
 *
 * Cadence:
 * - Full scan: every 5 minutes
 * - Near-qualified recheck: every 60 seconds
 * - Hot trigger watch: every 30 seconds
 */

import { etParts } from './ictTime.js';

export const AUTO_AI_WINDOW = { startMin: 2 * 60 + 15, endMin: 14 * 60 }; // 02:15–14:00 ET

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

const nearQualifiedPairs = new Set();
const hotPairs = new Set();

let _timers = [];

function parseInterval(name, fallbackMs) {
  const raw = process.env[name];
  const parsed = Number.parseInt(raw || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

/** True only on a NY weekday within 02:15–14:00 ET. */
export function inAutoAiWindow(input = new Date()) {
  const et = etParts(input);
  if (!et || et.isWeekend) return false;
  return et.minutesFromMidnight >= AUTO_AI_WINDOW.startMin && et.minutesFromMidnight < AUTO_AI_WINDOW.endMin;
}

/** Short correlation id for one scheduler tick, threaded through the whole path. */
export function makeRunId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Exposed for tests/debugging.
 */
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

  console.log(
    `[AUTO_AI] starting staged scheduler → ${nextUrl}/api/cron/auto-ai-trading ` +
    `(NY weekday 02:15–14:00 ET; full=${fullScanMs}ms near=${nearRecheckMs}ms hot=${hotWatchMs}ms)`,
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

  return {
    started: true,
    intervalMs: fullScanMs,
    fullScanMs,
    nearRecheckMs,
    hotWatchMs,
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
    console.log(`${logTag} outside Auto AI window — skip`);
    return { ok: true, skipped: true, reason: 'outside_window' };
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

    updateWatchStateFromCronResponse(text, tag);

    console.log(`${tag} complete ${text.slice(0, 300)}`);
    return { ok: true, status: res.status, body: text };
  } catch (err) {
    console.log(`${tag} cron unreachable: ${err?.message || err}`);
    return { ok: false, error: err?.message || String(err) };
  }
}

function updateWatchStateFromCronResponse(text, tag) {
  let json = null;

  try {
    json = JSON.parse(text);
  } catch {
    return;
  }

  if (Array.isArray(json.nearQualifiedPairs)) {
    nearQualifiedPairs.clear();
    for (const pair of json.nearQualifiedPairs) {
      if (pair) nearQualifiedPairs.add(String(pair).trim());
    }
    console.log(`${tag} updated nearQualifiedPairs=${Array.from(nearQualifiedPairs).join(',') || 'none'}`);
  }

  if (Array.isArray(json.hotPairs)) {
    hotPairs.clear();
    for (const pair of json.hotPairs) {
      if (pair) hotPairs.add(String(pair).trim());
    }
    console.log(`${tag} updated hotPairs=${Array.from(hotPairs).join(',') || 'none'}`);
  }

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
export function getNewYorkHour(date = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      hour12: false,
    }).format(date)
  );
  return hour === 24 ? 0 : hour;
}

export function isPrimaryTradeWindow(date = new Date()) {
  const hour = getNewYorkHour(date);
  return hour >= 2 && hour < 10;
}

export function isTrueHardReject(reason = "") {
  const r = String(reason).toLowerCase();
  return (
    r.includes("rr") && r.includes("1.5") ||
    r.includes("risk reward") && r.includes("below") ||
    r.includes("max daily loss") ||
    r.includes("daily loss") ||
    r.includes("max trades") ||
    r.includes("duplicate") ||
    r.includes("spread too high") ||
    r.includes("invalid broker") ||
    r.includes("credentials") ||
    r.includes("missing stop") ||
    r.includes("missing take profit") ||
    r.includes("live trading disabled") ||
    r.includes("execution disabled")
  );
}

export function softenRejectReasons(reasons = [], now = new Date()) {
  if (!isPrimaryTradeWindow(now)) return reasons;

  return reasons.filter((reason) => {
    const r = String(reason).toLowerCase();

    if (isTrueHardReject(r)) return true;

    if (
      r.includes("late_entry") ||
      r.includes("late entry") ||
      r.includes("flow opposes") ||
      r.includes("institutional flow") ||
      r.includes("missing smt") ||
      r.includes("missing fvg") ||
      r.includes("mixed ema") ||
      r.includes("emaalignment=mixed") ||
      r.includes("single opposing liquidity") ||
      r.includes("liquidity proxy")
    ) {
      return false;
    }

    return true;
  });
}

export function pickTradeMode(candidate = {}) {
  const rr = Number(candidate.rr ?? candidate.riskReward ?? candidate.expectedRR ?? 0);
  const confidence = Number(candidate.confidence ?? candidate.score ?? 0);

  if (rr >= 1.5 && confidence >= 70) return "SCALP";
  if (rr >= 1.5 && confidence >= 76) return "SWING";
  return "NONE";
}
// === END ACTIVE TRADE LOGIC PATCH ===



function prioritizeRetraceWatchPairs(pairs = []) {
  const watched = getRetraceWatchPairs();
  return [...new Set([...watched, ...pairs])];
}
