/**
 * server/oandaOverextension.js
 *
 * Detects "the move is already over" — the late-entry filter the user spec'd.
 *
 *   classifyOverextension({ candles, direction, ema20, atrPips, pair, structure, srProximity })
 *     → {
 *         lateEntryDetected: boolean,
 *         overextensionScore: 0–100,   // higher = more extended
 *         isPullbackEntry: boolean,    // healthy pullback signal vs chasing
 *         signals: {
 *           consecutiveSameColor: number,
 *           consecutiveBeyondEma:  number,
 *           emaDeviationAtr: number,
 *           atrPeakedAndDeclining: boolean,
 *           closeIntoSR: boolean,
 *           expansionAtrMultiple: number,
 *         },
 *         entryTimingReason: string,
 *       }
 *
 * Heuristics:
 *  - 4+ consecutive same-color candles in trade direction → "ran out of fuel"
 *  - Price > 2.5× ATR away from M15 EMA20 in trade direction → extended
 *  - Latest ATR(7) < ATR(7-of-prior-window) AND we're already extended → peak passed
 *  - Last candle closes within 8p of unbroken H4 S/R IN trade direction → into wall
 *
 *  Pullback override: if last 2-3 candles printed AGAINST the trade direction
 *  while the broader structure is still in-direction, classify as a healthy
 *  pullback entry — NOT a chase. lateEntryDetected stays false in that case.
 */

import { ema } from './oandaIndicators.js';

function pipSizeFor(pair) {
  if (String(pair || '').includes('JPY'))       return 0.01;
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return 0.01;
  if (String(pair || '').startsWith('NAS100') ||
      String(pair || '').startsWith('US30')   ||
      String(pair || '').startsWith('SPX500') ||
      String(pair || '').startsWith('DE30')   ||
      String(pair || '').startsWith('UK100')) return 1.0;
  return 0.0001;
}

function avg(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }

export function classifyOverextension({ candles, direction, atrPips, pair, structure, srProximity }) {
  if (!Array.isArray(candles) || candles.length < 30 || (direction !== 'long' && direction !== 'short')) {
    return {
      lateEntryDetected: false,
      overextensionScore: 0,
      isPullbackEntry: false,
      signals: null,
      entryTimingReason: 'Insufficient data for overextension check',
    };
  }

  const pipSize = pipSizeFor(pair);
  const closes = candles.map(c => c.close);
  const ema20 = ema(closes, 20);

  // ── Consecutive same-color candles in trade direction ─────────────────────
  let consecutiveSameColor = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i];
    const bull = c.close > c.open;
    const inDir = direction === 'long' ? bull : !bull;
    if (inDir) consecutiveSameColor++;
    else break;
  }

  // Consecutive bars where price (close) is ABOVE EMA (longs) / BELOW EMA (shorts)
  let consecutiveBeyondEma = 0;
  if (ema20 !== null) {
    for (let i = candles.length - 1; i >= 0; i--) {
      const beyond = direction === 'long' ? candles[i].close > ema20 : candles[i].close < ema20;
      if (beyond) consecutiveBeyondEma++;
      else break;
    }
  }

  // ── Price deviation from EMA20 in ATR units ──────────────────────────────
  const lastClose = closes[closes.length - 1];
  const deviationPrice = ema20 !== null ? Math.abs(lastClose - ema20) : 0;
  const atrPriceUnits = atrPips * pipSize;
  const emaDeviationAtr = atrPriceUnits > 0 ? deviationPrice / atrPriceUnits : 0;

  // ── ATR(7) recent vs prior — peak detection ──────────────────────────────
  const ranges = candles.slice(-30).map(c => c.high - c.low);
  const recent7 = ranges.slice(-7);
  const prior7  = ranges.slice(-14, -7);
  const atrRecent = avg(recent7);
  const atrPrior  = avg(prior7);
  const atrPeakedAndDeclining = atrPrior > 0 && atrRecent / atrPrior < 0.85 && emaDeviationAtr > 2.0;

  // ── Close into unbroken S/R in trade direction ───────────────────────────
  let closeIntoSR = false;
  if (srProximity) {
    const distToResPips = Number.isFinite(srProximity.distToResistancePips)
      ? srProximity.distToResistancePips : Infinity;
    const distToSupPips = Number.isFinite(srProximity.distToSupportPips)
      ? srProximity.distToSupportPips : Infinity;
    if (direction === 'long' && distToResPips < 8)  closeIntoSR = true;
    if (direction === 'short' && distToSupPips < 8) closeIntoSR = true;
  }
  // Structural near-key-level signal (preferred — actual H4 unbroken level)
  const nearKey = structure?.nearKeyLevel;
  if (nearKey && Number.isFinite(nearKey.distancePips) && nearKey.distancePips < 10) {
    if ((direction === 'long' && nearKey.kind === 'resistance') ||
        (direction === 'short' && nearKey.kind === 'support')) {
      closeIntoSR = true;
    }
  }

  // ── Expansion magnitude of the latest bar (chase candle?) ────────────────
  const lastBody = Math.abs(candles[candles.length - 1].close - candles[candles.length - 1].open);
  const avgPriorBody = avg(candles.slice(-12, -1).map(c => Math.abs(c.close - c.open)));
  const expansionAtrMultiple = atrPriceUnits > 0 ? lastBody / atrPriceUnits : 0;
  const isHugeChaseCandle = expansionAtrMultiple >= 1.2 && lastBody > avgPriorBody * 1.8;

  // ── Pullback override ────────────────────────────────────────────────────
  // If the last 2-3 bars are AGAINST the trade direction but the broader
  // structure stays aligned, treat as a healthy pullback entry.
  let pullbackBars = 0;
  for (let i = candles.length - 1; i >= candles.length - 4 && i >= 0; i--) {
    const c = candles[i];
    const bull = c.close > c.open;
    const against = direction === 'long' ? !bull : bull;
    if (against) pullbackBars++; else break;
  }
  const isPullbackEntry =
    pullbackBars >= 2 &&
    consecutiveSameColor === 0 &&
    structure?.pullbackDetected === true &&
    emaDeviationAtr < 1.5;

  // ── Score ────────────────────────────────────────────────────────────────
  let score = 0;
  if (consecutiveSameColor >= 6) score += 30;
  else if (consecutiveSameColor >= 4) score += 18;
  else if (consecutiveSameColor >= 3) score += 8;

  if (emaDeviationAtr >= 3.0) score += 30;
  else if (emaDeviationAtr >= 2.0) score += 18;
  else if (emaDeviationAtr >= 1.5) score += 8;

  if (atrPeakedAndDeclining) score += 20;
  if (closeIntoSR)           score += 25;
  if (isHugeChaseCandle)     score += 15;

  if (isPullbackEntry) score = Math.max(0, score - 30);
  score = Math.max(0, Math.min(100, score));

  const lateEntryDetected = !isPullbackEntry && (
    score >= 55 ||
    closeIntoSR ||
    consecutiveSameColor >= 6 ||
    emaDeviationAtr >= 3.0
  );

  // ── Reason ───────────────────────────────────────────────────────────────
  const reasons = [];
  if (consecutiveSameColor >= 4) reasons.push(`${consecutiveSameColor} consecutive ${direction === 'long' ? 'bull' : 'bear'} candles`);
  if (emaDeviationAtr >= 2.0)     reasons.push(`price ${emaDeviationAtr.toFixed(2)}× ATR from M15 EMA20`);
  if (atrPeakedAndDeclining)      reasons.push(`ATR peaked (recent ${atrRecent.toFixed(5)} < prior ${atrPrior.toFixed(5)})`);
  if (closeIntoSR)                reasons.push('closing into unbroken S/R in trade direction');
  if (isHugeChaseCandle)          reasons.push(`chase candle ${expansionAtrMultiple.toFixed(2)}× ATR`);
  if (isPullbackEntry)            reasons.push('healthy pullback — not chasing');
  const entryTimingReason = lateEntryDetected
    ? `Late entry: ${reasons.join('; ') || 'overextension score above threshold'}`
    : isPullbackEntry
      ? 'Pullback entry into in-direction structure'
      : reasons.length
        ? `Acceptable timing (${reasons.join('; ')})`
        : 'No overextension signals';

  return {
    lateEntryDetected,
    overextensionScore: score,
    isPullbackEntry,
    signals: {
      consecutiveSameColor,
      consecutiveBeyondEma,
      emaDeviationAtr: +emaDeviationAtr.toFixed(2),
      atrPeakedAndDeclining,
      closeIntoSR,
      expansionAtrMultiple: +expansionAtrMultiple.toFixed(2),
    },
    entryTimingReason,
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

  if (confidence >= 75 && rr >= 1.5) {
    return { mode: "SCALP", score, reject: null };
  }

  return {
    mode: "NONE",
    score,
    reject: "confidence below 75% scalp-only threshold",
  };
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
