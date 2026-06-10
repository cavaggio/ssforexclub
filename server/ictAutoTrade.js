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

function maskAccount(id) {
  return id && id.length > 4 ? `${id.slice(0, 3)}…${id.slice(-3)}` : '***';
}

export async function runAutoAiForUser({ client, now = new Date(), runId = null } = {}) {
  const cfg = ictExecConfig();
  const tag = `[AUTO_AI][ICT][runId=${runId ?? '-'}]`;
  const account = maskAccount(client?.accountId);
  const log = (m) => console.log(`${tag} account=${account} independentFromV3=true ${m}`);
  log('scan started');

  const { analyses } = await analyzeICTPairs(null, { client, now });
  const qualified = analyses.filter((a) => a.signal !== 'none' && a.confidence >= cfg.minConfidence);

  if (!qualified.length) {
    log(`scan complete pairs=${analyses.length} qualified=0 executed=0 skipped=0`);
    return { scanned: analyses.length, qualified: 0, executed: [], skipped: [] };
  }

  const executed = [];
  const skipped = [];
  for (const a of qualified) {
    log(`qualified ICT signal pair=${a.pair} dir=${a.signal} conf=${a.confidence}`);
    const direction = a.signal === 'buy' ? 'long' : 'short';
    const res = await executeIctTrade(
      { pair: a.pair, direction, units: 0, entry: a.entry, stopLoss: a.stopLoss, targetProfit: a.target1, ictSignalId: a.signalId },
      { client, now, autoAi: true },
    );
    if (res.success) {
      executed.push({ pair: a.pair, direction, tradeId: res.tradeId, units: res.units, holdMinutes: res.holdMinutes });
      log(`trade executed pair=${a.pair} dir=${direction} id=${res.tradeId}`);
    } else {
      skipped.push({ pair: a.pair, reason: res.reason });
      log(`execution skipped pair=${a.pair} reason="${res.reason}"`);
    }
  }
  log(`scan complete pairs=${analyses.length} qualified=${qualified.length} executed=${executed.length} skipped=${skipped.length}`);
  return { scanned: analyses.length, qualified: qualified.length, executed, skipped };
}
