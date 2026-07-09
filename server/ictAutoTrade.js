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

function buildIctWatchState(analyses = [], minConfidence = 80) {
  const nearQualifiedPairs = new Set();
  const hotPairs = new Set();
  const lateEntryPairs = new Set();

  for (const item of analyses) {
    const pair = item?.pair;
    if (!pair) continue;

    let text = '';
    try { text = JSON.stringify(item || {}).toLowerCase(); }
    catch { text = String(item || '').toLowerCase(); }

    const confidence = Number(item?.confidence ?? 0);
    const hasDirectionalSignal = item?.signal && item.signal !== 'none';

    if (text.includes('late_entry') || text.includes('overextended')) {
      lateEntryPairs.add(pair);
      continue;
    }

    if (hasDirectionalSignal && confidence >= minConfidence) {
      hotPairs.add(pair);
      continue;
    }

    if (
      confidence >= Math.max(60, minConfidence - 15) ||
      text.includes('sweep') ||
      text.includes('liquidity') ||
      text.includes('fvg') ||
      text.includes('order block') ||
      text.includes('order_block') ||
      text.includes('pending')
    ) {
      nearQualifiedPairs.add(pair);
    }
  }

  for (const pair of lateEntryPairs) {
    nearQualifiedPairs.delete(pair);
    hotPairs.delete(pair);
  }

  return {
    nearQualifiedPairs: Array.from(nearQualifiedPairs),
    hotPairs: Array.from(hotPairs),
    lateEntryPairs: Array.from(lateEntryPairs),
  };
}

export async function runAutoAiForUser({ client, now = new Date(), runId = null, scanMode = 'full', pairs = null } = {}) {
  const cfg = ictExecConfig();
  const tag = `[AUTO_AI][ICT][runId=${runId ?? '-'}]`;
  const account = maskAccount(client?.accountId);
  const log = (m) => console.log(`${tag} account=${account} independentFromV3=true ${m}`);
  const scanPairs = Array.isArray(pairs) && pairs.length ? pairs : null;
  log(`scan started scanMode=${scanMode} pairs=${scanPairs?.length ? scanPairs.join(',') : 'ALL'}`);

  const { analyses } = await analyzeICTPairs(scanPairs, { client, now, scanMode });
  const qualified = analyses.filter((a) => a.signal !== 'none' && a.confidence >= cfg.minConfidence);
  const watchState = buildIctWatchState(analyses, cfg.minConfidence);

  if (!qualified.length) {
    log(`scan complete pairs=${analyses.length} qualified=0 executed=0 skipped=0`);
    return { scanned: analyses.length, qualified: 0, executed: [], skipped: [], ...watchState };
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
  return { scanned: analyses.length, qualified: qualified.length, executed, skipped, ...watchState };
}


// June 23 soft-filter scoring
// These filters should influence confidence, not hard-reject otherwise valid trades.
export function applyJune23SoftFilterScoring(candidate = {}) {
  let confidenceAdjustment = 0;
  const softReasons = [];

  if (candidate.regimeAligned === true) {
    confidenceAdjustment += 1;
    softReasons.push("Regime aligned: +1 confidence");
  } else if (candidate.regimeAligned === false) {
    confidenceAdjustment -= 1;
    softReasons.push("Regime not aligned: -1 confidence");
  }

  if (candidate.liquidityIntentStrong === true) {
    confidenceAdjustment += 2;
    softReasons.push("Strong liquidity intent: +2 confidence");
  } else if (candidate.liquidityIntentStrong === false) {
    confidenceAdjustment -= 1;
    softReasons.push("Weak liquidity intent: -1 confidence");
  }

  if (candidate.calibrationPositive === true) {
    confidenceAdjustment += 1;
    softReasons.push("Positive calibration: +1 confidence");
  } else if (candidate.calibrationPositive === false) {
    confidenceAdjustment -= 1;
    softReasons.push("Negative calibration: -1 confidence");
  }

  if (candidate.smtDivergence === true) {
    confidenceAdjustment += 1;
    softReasons.push("SMT divergence present: +1 confidence");
  }

  if (candidate.sessionNarrativeAligned === true) {
    confidenceAdjustment += 1;
    softReasons.push("Session narrative aligned: +1 confidence");
  }

  const baseConfidence = Number(candidate.confidence ?? 0);
  const finalConfidence = Math.max(0, Math.min(100, baseConfidence + confidenceAdjustment));

  return {
    ...candidate,
    baseConfidence,
    confidence: finalConfidence,
    confidenceAdjustment,
    softReasons,
  };
}


