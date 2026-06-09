/**
 * server/ictAutoScheduler.js
 *
 * Railway-side 5-minute trigger for autonomous ICT auto-trading. It does NOT
 * resolve credentials or execute itself — Railway has no Clerk/decrypt context.
 * Each in-window tick POSTs a protected Next endpoint
 * (/api/cron/auto-ai-trading), which enumerates opted-in users, resolves each
 * user's creds, and calls back into the Railway internal ICT endpoints.
 *
 * Off by default (ICT_AUTO_AI_SCHEDULER_ENABLED=false). Only fires on NY
 * weekdays between 02:00 and 11:00 ET (DST-aware via ictTime).
 */

import { etParts } from './ictTime.js';

export const AUTO_AI_WINDOW = { startMin: 2 * 60, endMin: 11 * 60 }; // 02:00–11:00 ET

/** True only on a NY weekday within 02:00–11:00 ET. */
export function inAutoAiWindow(input = new Date()) {
  const et = etParts(input);
  if (!et || et.isWeekend) return false;
  return et.minutesFromMidnight >= AUTO_AI_WINDOW.startMin && et.minutesFromMidnight < AUTO_AI_WINDOW.endMin;
}

const INTERVAL_MS = 5 * 60 * 1000;
let _timer = null;

export function startAutoAiScheduler({ intervalMs = INTERVAL_MS } = {}) {
  if (String(process.env.ICT_AUTO_AI_SCHEDULER_ENABLED || 'false').toLowerCase() !== 'true') {
    console.log('[AUTO_AI] ICT_AUTO_AI_SCHEDULER_ENABLED!=true — scheduler not started');
    return { started: false, reason: 'disabled_by_env' };
  }
  if (_timer) {
    console.log('[AUTO_AI] scheduler already running — skipping duplicate start');
    return { started: false, reason: 'already_running' };
  }
  const nextUrl = process.env.NEXT_BASE_URL;
  const secret = process.env.AUTO_AI_CRON_SECRET;
  if (!nextUrl || !secret) {
    console.log('[AUTO_AI] NEXT_BASE_URL / AUTO_AI_CRON_SECRET not set — scheduler not started');
    return { started: false, reason: 'missing_config' };
  }
  console.log(`[AUTO_AI] starting 5-min scheduler → ${nextUrl}/api/cron/auto-ai-trading (NY weekday 02:00–11:00 ET)`);
  _timer = setInterval(() => { void tick(nextUrl, secret); }, intervalMs);
  if (typeof _timer.unref === 'function') _timer.unref();
  return { started: true, intervalMs };
}

/** Short correlation id for one scheduler tick, threaded through the whole path. */
export function makeRunId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function tick(nextUrl, secret) {
  if (!inAutoAiWindow(new Date())) return; // silent no-op outside the NY window
  const runId = makeRunId();
  const tag = `[AUTO_AI][ICT][runId=${runId}]`;
  console.log(`${tag} scan started independentFromV3=true`);
  try {
    const res = await fetch(`${String(nextUrl).replace(/\/$/, '')}/api/cron/auto-ai-trading`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cron-Secret': secret },
      body: JSON.stringify({ source: 'railway-scheduler', runId }),
    });
    const text = await res.text();
    if (!res.ok) console.log(`${tag} cron call failed ${res.status}: ${text.slice(0, 200)}`);
    else console.log(`${tag} complete ${text.slice(0, 200)}`);
  } catch (err) {
    console.log(`${tag} cron unreachable: ${err?.message || err}`);
  }
}

export function stopAutoAiScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; return { stopped: true }; }
  return { stopped: false, reason: 'not_running' };
}
