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
import { configuredIctWatchlist, isIctExecutionEligibleInstrument } from './ictWatchlist.js';
import { runDailyMarketStudy } from './dailyMarketStudy.js';
import { applyCombinedLearningCalibration } from './engineTradeLearning.js';

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rejectionReasonsOf(item) {
  return Array.isArray(item?.rejectionReasons)
    ? item.rejectionReasons.map((reason) => String(reason || ''))
    : [];
}

function isWaitableTriggerReason(reason) {
  const text = String(reason || '').toLowerCase();
  return text.includes('no 5m entry-timing trigger') ||
    text.includes('no fresh 5m impulse/structure trigger') ||
    text.includes('await for it to turn') ||
    text.includes('wait for it to turn') ||
    text.includes('last completed h1 candle') ||
    text.includes('current live h1 candle is unavailable');
}

function hasBlockingHardReject(item) {
  return rejectionReasonsOf(item).some((reason) =>
    /^hard gate:/i.test(reason) && !isWaitableTriggerReason(reason)
  );
}

function hasLateOrInvalidTiming(item) {
  return rejectionReasonsOf(item).some((reason) => {
    const text = reason.toLowerCase();
    return text.includes('late market entry') ||
      text.includes('transition window has ended') ||
      text.includes('do not chase the end of momentum') ||
      text.includes('outside the valid ict entry zone') ||
      text.includes('nearest natural liquidity target does not provide') ||
      text.includes('executable r:r') ||
      text.includes('news block');
  });
}

function hasConcreteIctContext(item) {
  const labels = Array.isArray(item?.conceptsDetected) ? item.conceptsDetected : [];
  return labels.some((label) =>
    /^(liquidity sweep|displacement|mss|bos|choch|.* fvg|.* ob|ote|killzone:|daily+4h aligned)/i.test(String(label || ''))
  );
}

function hasExecutableGeometry(item, minimumRR) {
  const entry = finiteNumber(item?.entry);
  const stop = finiteNumber(item?.stopLoss);
  const target = finiteNumber(item?.target1);
  const rr = finiteNumber(item?.rr);
  const bias = String(item?.ictBias || item?.direction || '').toLowerCase();
  const bullish = bias === 'bullish' || bias === 'long' || item?.signal === 'buy';
  const bearish = bias === 'bearish' || bias === 'short' || item?.signal === 'sell';
  if (![entry, stop, target, rr].every(Number.isFinite)) return false;
  if (rr < minimumRR || item?.targetAdjustedToMinRR === true) return false;
  if (bullish) return stop < entry && target > entry;
  if (bearish) return stop > entry && target < entry;
  return false;
}

export function maskAccountForLog(id) {
  const value = String(id || '');
  const parts = value.split('-').filter(Boolean);
  if (parts.length >= 3) {
    const core = parts.at(-2) || '';
    return parts[0] + '…' + core.slice(-4) + '…' + (parts.at(-1) || '');
  }
  return value.length > 6 ? value.slice(0, 3) + '…' + value.slice(-4) : '***';
}

const maskAccount = maskAccountForLog;

export function buildIctWatchState(analyses = [], minConfidence = 80, minRR = 1.5) {
  const nearQualifiedPairs = new Set();
  const hotPairs = new Set();
  const lateEntryPairs = new Set();
  const cfg = { minConfidence: Number(minConfidence), minRR: Number(minRR) };
  const nearFloor = Math.max(60, cfg.minConfidence - 15);

  for (const item of analyses) {
    const pair = item?.pair;
    if (!pair) continue;
    const displayQualified = item?.signal !== 'none' &&
      Number.isFinite(Number(item?.confidence)) && Number(item.confidence) >= cfg.minConfidence &&
      Number.isFinite(Number(item?.rr)) && Number(item.rr) >= cfg.minRR;
    if (displayQualified) {
      hotPairs.add(pair);
      continue;
    }
    if (hasLateOrInvalidTiming(item)) {
      lateEntryPairs.add(pair);
      continue;
    }

    const confidence = finiteNumber(item?.confidence) ?? 0;
    const bias = String(item?.ictBias || item?.direction || '').toLowerCase();
    const directionalBias = ['bullish', 'bearish', 'long', 'short'].includes(bias);
    const waitingForTrigger = rejectionReasonsOf(item).some(isWaitableTriggerReason);
    const triggerAge = finiteNumber(item?.triggerAgeBars);
    const freshTrigger = item?.freshImpulse === true || (triggerAge != null && triggerAge <= 1);

    if (
      directionalBias &&
      !hasBlockingHardReject(item) &&
      hasConcreteIctContext(item) &&
      hasExecutableGeometry(item, cfg.minRR) &&
      confidence >= nearFloor &&
      (freshTrigger || waitingForTrigger)
    ) nearQualifiedPairs.add(pair);
  }

  for (const pair of lateEntryPairs) {
    nearQualifiedPairs.delete(pair);
    hotPairs.delete(pair);
  }

  return {
    nearQualifiedPairs: [...nearQualifiedPairs],
    hotPairs: [...hotPairs],
    lateEntryPairs: [...lateEntryPairs],
  };
}

export function isIctAutoQualified(analysis, cfg = ictExecConfig()) {
  const confidence = Number(analysis?.confidence);
  const rr = Number(analysis?.rr);
  const entryAuthorization = analysis?.entryAuthorization || {};
  const pairEligible = analysis?.pair
    ? isIctExecutionEligibleInstrument(analysis.pair)
    : analysis?.executionEligible !== false;
  return pairEligible &&
    analysis?.executionEligible !== false &&
    analysis?.signal !== 'none' &&
    analysis?.entryTimeframe === '5M' &&
    analysis?.entryCandle?.triggerReady === true &&
    analysis?.freshImpulse === true &&
    entryAuthorization.ready === true &&
    Boolean(entryAuthorization.cycleId) &&
    analysis?.marketMakerModel?.studyReady === true &&
    analysis?.marketMakerModel?.stage === 'DISTRIBUTION_ACTIVE' &&
    Number.isFinite(confidence) && confidence >= cfg.minConfidence &&
    Number.isFinite(rr) && rr >= cfg.minRR;
}

export async function runAutoAiForUser({
  client,
  now = new Date(),
  runId = null,
  scanMode = 'full',
  pairs = null,
  executionAllowed = true,
  executionBlockedReason = null,
} = {}) {
  const cfg = ictExecConfig();
  const tag = `[AUTO_AI][ICT][runId=${runId ?? '-'}]`;
  const account = maskAccount(client?.accountId);
  const log = (m) => console.log(`${tag} account=${account} independentFromV3=true ${m}`);
  const hardWatchlist = configuredIctWatchlist();
  const allowedPairs = new Set(hardWatchlist);
  const requestedPairs = Array.isArray(pairs) && pairs.length
    ? [...new Set(pairs.map((pair) => String(pair || '').trim().toUpperCase()).filter(Boolean))]
    : hardWatchlist;
  const scanPairs = requestedPairs.filter((pair) => allowedPairs.has(pair));
  const blockedPairs = requestedPairs.filter((pair) => !allowedPairs.has(pair));
  if (blockedPairs.length) log(`hard-watchlist blocked pairs=${blockedPairs.join(',')}`);
  log(`scan started scanMode=${scanMode} pairs=${scanPairs.join(',')} hardWatchlist=${hardWatchlist.join(',')}`);
  if (!scanPairs.length) {
    return {
      scanned: 0, qualified: 0, executed: [],
      skipped: [{ reason: 'ICT hard watchlist rejected every requested pair', pairs: blockedPairs }],
      nearQualifiedPairs: [], hotPairs: [], lateEntryPairs: [],
      hardWatchlist, blockedPairs, executionAllowed: false,
    };
  }

  if (scanMode === 'daily_study') {
    return runDailyMarketStudy({ client, engine: 'ict', pairs: scanPairs, now });
  }

  const { analyses: rawAnalyses } = await analyzeICTPairs(scanPairs, { client, now, scanMode });
  const analyses = await Promise.all(rawAnalyses.map((item) =>
    applyCombinedLearningCalibration(item, { client, engine: 'ict' })
  ));
  const qualified = analyses.filter((analysis) => isIctAutoQualified(analysis, cfg));
  const watchState = buildIctWatchState(analyses, cfg.minConfidence, cfg.minRR);

  if (!qualified.length) {
    log(`scan complete pairs=${analyses.length} qualified=0 executed=0 skipped=0`);
    return { scanned: analyses.length, qualified: 0, executed: [], skipped: [], results: analyses, ...watchState };
  }

  if (executionAllowed === false) {
    const reason = executionBlockedReason || 'ICT scan-only window: new orders are not allowed yet';
    const skipped = qualified.map((analysis) => ({
      pair: analysis.pair,
      direction: analysis.signal === 'buy' ? 'long' : 'short',
      reason,
    }));
    log(`scan-only gate active qualified=${qualified.length} executed=0 reason="${reason}"`);
    return {
      scanned: analyses.length,
      qualified: qualified.length,
      executed: [],
      skipped,
      executionAllowed: false,
      ...watchState,
    };
  }

  const executed = [];
  const skipped = [];
  for (const a of qualified) {
    log(`qualified ICT signal pair=${a.pair} dir=${a.signal} conf=${a.confidence}`);
    const direction = a.signal === 'buy' ? 'long' : 'short';
    const res = await executeIctTrade(
      { pair: a.pair, direction, units: 0, entry: a.entry, stopLoss: a.stopLoss, targetProfit: a.target1, ictSignalId: a.signalId },
      { client, now, autoAi: true, authoritativeAnalysis: a },
    );
    if (res.success) {
      executed.push({
        pair: a.pair,
        direction,
        tradeId: res.tradeId,
        fillPrice: res.fillPrice ?? a.entry,
        units: res.units,
        stopLoss: res.stopLoss ?? a.stopLoss,
        takeProfit: res.takeProfit ?? a.target1,
        confidence: a.confidence,
        expectedRR: a.rr,
        holdMinutes: res.holdMinutes,
        strategy: 'ICT',
        signal: a,
      });
      log(`trade executed pair=${a.pair} dir=${direction} id=${res.tradeId}`);
    } else {
      skipped.push({ pair: a.pair, reason: res.reason });
      log(`execution skipped pair=${a.pair} reason="${res.reason}"`);
    }
  }
  log(`scan complete pairs=${analyses.length} qualified=${qualified.length} executed=${executed.length} skipped=${skipped.length}`);
  return { scanned: analyses.length, qualified: qualified.length, executed, skipped, results: analyses, ...watchState };
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

  if (confidence >= 80 && rr >= 1.5) {
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
