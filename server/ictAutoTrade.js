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

function buildIctWatchState(analyses = [], minConfidence = 85) {
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

    if (!isActiveOpportunityWindow(new Date()) && (text.includes('late_entry') || text.includes('overextended'))) {
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






// === OPPORTUNITY RANKING PATCH ===
function getNYHour(date = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      hour12: false,
    }).format(date)
  );
  return hour === 24 ? 0 : hour;
}

function isActiveOpportunityWindow(date = new Date()) {
  const h = getNYHour(date);
  return h >= 2 && h < 10;
}

function isProtectedHardBlock(reason = "") {
  const r = String(reason).toLowerCase();
  return (
    r.includes("rr < 1.5") ||
    r.includes("risk reward below") ||
    r.includes("spread too high") ||
    r.includes("duplicate") ||
    r.includes("max trades") ||
    r.includes("daily loss") ||
    r.includes("missing stop") ||
    r.includes("missing take profit") ||
    r.includes("invalid broker") ||
    r.includes("credentials") ||
    r.includes("live trading disabled") ||
    r.includes("execution disabled")
  );
}

function convertLateEntryToTradableStatus(status, reason = "", now = new Date()) {
  if (!isActiveOpportunityWindow(now)) return { status, reason };

  const s = String(status || "").toLowerCase();
  const r = String(reason || "").toLowerCase();

  if (
    s === "late_entry" ||
    r.includes("late entry") ||
    r.includes("overextended") ||
    r.includes("flow opposes") ||
    r.includes("institutional flow")
  ) {
    return {
      status: "valid_entry",
      reason: `Active-window tradable opportunity: ${reason || status}`,
      warning: true,
    };
  }

  return { status, reason };
}

function rankOpportunity(candidate = {}) {
  const rr = Number(candidate.rr ?? candidate.riskReward ?? candidate.expectedRR ?? 0);
  const confidence = Number(candidate.confidence ?? candidate.score ?? candidate.alignScore ?? 0);
  const spreadOk = candidate.spreadOk !== false;
  const duplicate = candidate.duplicate === true || candidate.hasDuplicate === true;

  if (rr < 1.5) return { mode: "NONE", score: 0, reject: "RR < 1.5" };
  if (!spreadOk) return { mode: "NONE", score: 0, reject: "spread too high" };
  if (duplicate) return { mode: "NONE", score: 0, reject: "duplicate active trade" };

  let score = 0;
  score += Math.min(confidence, 100);
  score += Math.min(rr * 12, 40);

  if (candidate.entryStatus === "valid_entry") score += 15;
  if (candidate.entryStatus === "wait_for_retest") score += 8;
  if (candidate.macroBias && candidate.direction && String(candidate.macroBias).includes(candidate.direction)) score += 10;

  if (confidence >= 85 && rr >= 1.5) {
    return { mode: "SCALP", score, reject: null };
  }

  return { mode: "NONE", score, reject: "confidence below opportunity threshold" };
}

function softenActiveWindowRejects(reasons = [], now = new Date()) {
  if (!isActiveOpportunityWindow(now)) return reasons;

  return reasons.filter((reason) => {
    const r = String(reason).toLowerCase();

    if (isProtectedHardBlock(r)) return true;

    if (
      r.includes("late_entry") ||
      r.includes("late entry") ||
      r.includes("overextended") ||
      r.includes("flow opposes") ||
      r.includes("institutional flow") ||
      r.includes("missing smt") ||
      r.includes("missing fvg") ||
      r.includes("mixed ema") ||
      r.includes("liquidity proxy")
    ) {
      return false;
    }

    return true;
  });
}
// === END OPPORTUNITY RANKING PATCH ===

