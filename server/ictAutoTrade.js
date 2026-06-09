/**
 * server/ictAutoTrade.js
 *
 * Autonomous-entry runner for ONE user (per-request OANDA client supplied by the
 * Next cron after resolving that user's creds). Analyzes the ICT watchlist,
 * picks qualified signals (≥ ICT_MIN_CONFIDENCE), and routes each through
 * executeIctTrade — which enforces every gate (mode/auto-flag/live-ack/recompute/
 * news/duplicate-lock/sizing). Duplicate protection is the shared trade lock, so
 * a pair/direction already open is skipped. Recommend nothing here; this only
 * acts when execution is fully enabled.
 */

import { analyzeICTPairs, ictExecConfig } from './ictEngine.js';
import { executeIctTrade } from './ictExecution.js';

export async function runAutoAiForUser({ client, now = new Date() } = {}) {
  const cfg = ictExecConfig();
  const log = (m) => console.log(`[AUTO_AI] ${m}`);
  log('scan started');

  const { analyses } = await analyzeICTPairs(null, { client, now });
  const qualified = analyses.filter((a) => a.signal !== 'none' && a.confidence >= cfg.minConfidence);

  if (!qualified.length) {
    log('no qualified ICT signal');
    return { scanned: analyses.length, qualified: 0, executed: [], skipped: [] };
  }

  const executed = [];
  const skipped = [];
  for (const a of qualified) {
    log(`qualified ICT signal found: ${a.pair} ${a.signal} conf=${a.confidence}`);
    const direction = a.signal === 'buy' ? 'long' : 'short';
    const res = await executeIctTrade(
      { pair: a.pair, direction, units: 0, entry: a.entry, stopLoss: a.stopLoss, targetProfit: a.target1, ictSignalId: a.signalId },
      { client, now },
    );
    if (res.success) {
      executed.push({ pair: a.pair, direction, tradeId: res.tradeId, units: res.units, holdMinutes: res.holdMinutes });
      log(`trade executed: ${a.pair} ${direction} id=${res.tradeId}`);
    } else {
      skipped.push({ pair: a.pair, reason: res.reason });
      log(`execution skipped: ${a.pair} — ${res.reason}`);
    }
  }
  return { scanned: analyses.length, qualified: qualified.length, executed, skipped };
}
