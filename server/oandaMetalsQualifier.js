/**
 * server/oandaMetalsQualifier.js
 *
 * Dedicated qualification model for XAU_USD / XAG_USD.
 *
 * Why metals need their own path:
 *   - Spreads are 30–50× a forex pair's; the spread/TP math fails fast.
 *   - Liquidity-sweep behaviour is common (gold "fake-breaks" prior day H/L
 *     before reversing). A pattern that's noise on EUR/USD is signal on XAU.
 *   - Wick rejections matter more — a 5-pip wick on EUR/USD is nothing, a
 *     50-pip upper wick on XAU/USD is a serious supply event.
 *   - Asia-session metals trades are notoriously low-quality.
 *
 * This module REUSES the analysis already computed by the scanner
 * (candleStrength, marketState, mtfAuthority, overextension, institutionalFlow,
 * fibonacci, news, entry-timing) — it only changes the THRESHOLDS, adds a
 * prior-session-extreme check, and rolls everything into a single accept /
 * reject decision with metals-flavoured reasons.
 *
 *   qualifyMetalsSignal(ctx)  →  { accepted, ...metalsFields }
 *   buildMetalsContext        — convenience helper (light wrapper)
 *   scoreMetalsSetup          — internal scorer exported for tests
 */

// ─── Thresholds (deliberately stricter than the forex floors) ────────────────
const MIN_CANDLE_STRENGTH      = 60;
const MIN_MARKET_STATE_SCORE   = 70;
const MIN_MTF_ALIGNMENT_SCORE  = 65;       // unless reversal setup
const MAX_OVEREXTENSION_SCORE  = 50;
const PREFERRED_SESSIONS = new Set([
  'London', 'NewYork', 'London/NewYork Overlap',
]);

const PIP_SIZE = 0.01;  // XAU and XAG both use 0.01 on OANDA

/**
 * Identify the prior session's high/low from the most recent ~30 H1 candles.
 * "Session" here is a 24-hour rolling window — good enough for the prior-day
 * high/low filter without bringing a calendar in.
 */
function findPriorSessionExtremes(h1Candles) {
  if (!Array.isArray(h1Candles) || h1Candles.length < 30) return null;
  // Skip the most recent 4 bars so we don't re-test today's structure.
  const window = h1Candles.slice(-30, -4);
  if (window.length < 12) return null;
  const high = Math.max(...window.map(c => c.high));
  const low  = Math.min(...window.map(c => c.low));
  return { high, low };
}

/**
 * Pure scorer — returns 0–100. Higher = better metals setup.
 *   +25  candleStrength    ≥ 70                +12  ≥ 60
 *   +20  marketStateScore  ≥ 80                +10  ≥ 70
 *   +20  mtfAlignment      ≥ 75                +10  ≥ 65
 *   +15  preferredSession                       +0   else
 *   +10  pullback or retest evidence
 *   +10  reversal setup confirmed by flow (sweep + CHoCH/BOS)
 *   −20  overextension flag                    (already-late)
 *   −25  candle classification === 'rejection'
 *   −15  upper wick on long / lower wick on short ≥ 1.5× body
 */
export function scoreMetalsSetup({
  candleStrength, marketState, mtfAuthority, overextension,
  institutionalFlow, session, direction,
}) {
  let s = 30;
  if (candleStrength?.candleStrengthScore >= 70) s += 25;
  else if (candleStrength?.candleStrengthScore >= 60) s += 12;

  if (marketState?.marketStateScore >= 80) s += 20;
  else if (marketState?.marketStateScore >= 70) s += 10;

  const align = mtfAuthority?.multiTimeframeAlignmentScore ?? 0;
  if (align >= 75) s += 20;
  else if (align >= 65) s += 10;

  if (PREFERRED_SESSIONS.has(session)) s += 15;

  const flows = institutionalFlow?.signals || [];
  const tradeSign = direction === 'long' ? 'bullish' : 'bearish';
  const hasPullbackOrRetest =
    overextension?.isPullbackEntry === true ||
    flows.some(f => (f.type === 'retest' || f.type === 'break_of_structure') && f.direction === tradeSign);
  if (hasPullbackOrRetest) s += 10;

  const hasReversalConfirm =
    mtfAuthority?.isReversalSetup &&
    flows.some(f => (f.type === 'choch' || f.type === 'liquidity_sweep') && f.direction === tradeSign);
  if (hasReversalConfirm) s += 10;

  if (overextension?.lateEntryDetected) s -= 20;
  if (candleStrength?.classification === 'rejection') s -= 25;

  const rejWick = candleStrength?.components?.wickRejectionRatio || 0;
  if (rejWick >= 1.5) s -= 15;

  return Math.max(0, Math.min(100, Math.round(s)));
}

export function buildMetalsContext({
  pair, direction,
  m15Candles, h1Candles, h4Candles, currentPrice,
  candleStrength, marketState, mtfAuthority, overextension,
  institutionalFlow, fibonacci, entryTiming, newsRisk,
  pricing, lifecycle, session, profile,
}) {
  return {
    pair, direction,
    m15Candles, h1Candles, h4Candles, currentPrice,
    candleStrength, marketState, mtfAuthority, overextension,
    institutionalFlow, fibonacci, entryTiming, newsRisk,
    pricing, lifecycle, session, profile,
  };
}

/**
 * Main entry. Returns the user-spec'd payload with `accepted` indicating
 * whether the trade should pass the metals layer.
 */
export function qualifyMetalsSignal(ctx) {
  const {
    pair, direction, h1Candles, currentPrice,
    candleStrength, marketState, mtfAuthority, overextension,
    institutionalFlow, lifecycle, session, pricing,
  } = ctx;

  const metalsRejectionReasons = [];
  const tradeSign = direction === 'long' ? 'bullish' : 'bearish';

  // 1. Candle strength floor
  if ((candleStrength?.candleStrengthScore ?? 0) < MIN_CANDLE_STRENGTH) {
    metalsRejectionReasons.push(
      `Rejected by metals logic: candle strength ${candleStrength?.candleStrengthScore ?? 0} ` +
      `< metals floor ${MIN_CANDLE_STRENGTH}. ${candleStrength?.reason ?? ''}`
    );
  }

  // 2. Market state must be supportive AND score must be high
  if ((marketState?.marketStateScore ?? 0) < MIN_MARKET_STATE_SCORE) {
    metalsRejectionReasons.push(
      `Rejected by metals logic: market state score ${marketState?.marketStateScore ?? 0} ` +
      `< metals floor ${MIN_MARKET_STATE_SCORE}. ${marketState?.marketStateReason ?? ''}`
    );
  }
  if (marketState?.marketState === 'CHOPPY' || marketState?.marketState === 'RANGING') {
    metalsRejectionReasons.push(
      `Rejected by metals logic: metals do not trade ${marketState.marketState.toLowerCase()} states reliably`
    );
  }

  // 3. MTF alignment (relaxed if it's an explicit reversal setup with flow confirmation)
  const isReversal = mtfAuthority?.isReversalSetup === true;
  const align = mtfAuthority?.multiTimeframeAlignmentScore ?? 0;
  const flows = institutionalFlow?.signals || [];
  const reversalConfirmed = isReversal && flows.some(
    f => (f.type === 'choch' || f.type === 'liquidity_sweep') && f.direction === tradeSign
  );
  if (align < MIN_MTF_ALIGNMENT_SCORE && !reversalConfirmed) {
    metalsRejectionReasons.push(
      `Rejected by metals logic: MTF alignment ${align}/100 < metals floor ${MIN_MTF_ALIGNMENT_SCORE} ` +
      `(no confirmed reversal evidence). ${mtfAuthority?.multiTimeframeReason ?? ''}`
    );
  }

  // 4. Overextension / late entry
  if (overextension?.lateEntryDetected ||
      (overextension?.overextensionScore ?? 0) > MAX_OVEREXTENSION_SCORE) {
    metalsRejectionReasons.push(
      `Active-window metals warning: late entry / overextension. ${overextension?.entryTimingReason ?? ''}`
    );
  }

  // 5. Liquidity sweep / failed breakout in OPPOSITE direction
  const opposingSweep = flows.find(
    f => (f.type === 'liquidity_sweep' || f.subtype === 'failed_breakout') &&
         f.direction !== 'neutral' &&
         f.direction !== tradeSign
  );
  if (opposingSweep) {
    metalsRejectionReasons.push(
      `Rejected by metals logic: opposing liquidity sweep / failed breakout. ${opposingSweep.reason}`
    );
  }

  // 6. Session restriction — metals demand London/NY liquidity
  if (!PREFERRED_SESSIONS.has(session)) {
    metalsRejectionReasons.push(
      `Rejected by metals logic: ${session} session is outside metals preferred window (London / NY)`
    );
  }

  // 7. Prior session high/low proximity. Reject if entry is within 0.5×ATR
  //    of yesterday's H/L AND moving INTO it.
  const priorExtremes = findPriorSessionExtremes(h1Candles);
  const atrPips = marketState?.macroAtrPips || 0;
  const atrPipsFromCandle = candleStrength?.components?.range ? candleStrength.components.range / PIP_SIZE : 0;
  const atrPipsEffective = atrPips || atrPipsFromCandle || 60;
  if (priorExtremes && Number.isFinite(currentPrice)) {
    const proximityPips = atrPipsEffective * 0.5;
    const proximityPrice = proximityPips * PIP_SIZE;
    if (direction === 'long' &&
        priorExtremes.high > currentPrice &&
        (priorExtremes.high - currentPrice) < proximityPrice) {
      metalsRejectionReasons.push(
        `Rejected by metals logic: long entry within 0.5×ATR of prior session high ${priorExtremes.high.toFixed(2)} — wall risk`
      );
    }
    if (direction === 'short' &&
        priorExtremes.low < currentPrice &&
        (currentPrice - priorExtremes.low) < proximityPrice) {
      metalsRejectionReasons.push(
        `Rejected by metals logic: short entry within 0.5×ATR of prior session low ${priorExtremes.low.toFixed(2)} — wall risk`
      );
    }
  }

  // 8. Spread / TP economics — metals-stricter cap (10%)
  const tpPips = lifecycle?.tp?.takeProfitPips;
  const spreadPips = pricing?.spreadPips;
  if (tpPips && spreadPips && (spreadPips / tpPips) > 0.10) {
    metalsRejectionReasons.push(
      `Rejected by metals logic: spread ${spreadPips}p / TP ${tpPips}p = ` +
      `${((spreadPips / tpPips) * 100).toFixed(0)}% > metals cap 10%`
    );
  }

  // ── Score + reason strings ────────────────────────────────────────────────
  const metalsSetupScore = scoreMetalsSetup({
    candleStrength, marketState, mtfAuthority, overextension,
    institutionalFlow, session, direction,
  });

  const metalsVolatilityReason =
    `Market state ${marketState?.marketState} (${marketState?.marketStateScore}/100), ` +
    `candle ${candleStrength?.classification} (${candleStrength?.candleStrengthScore}), ` +
    `${overextension?.lateEntryDetected ? 'late entry detected' : 'entry timing ok'}`;

  const metalsSessionReason = PREFERRED_SESSIONS.has(session)
    ? `Preferred metals session: ${session}`
    : `Sub-optimal metals session: ${session}`;

  const metalsLiquidityReason = flows.length
    ? `Flow proxies: ${flows.map(f => `${f.timeframe} ${f.type}/${f.direction}`).join(', ')}`
    : 'No institutional flow proxies detected';

  return {
    selectedLogicType: 'metals',
    accepted: metalsRejectionReasons.length === 0,
    metalsSetupScore,
    metalsVolatilityReason,
    metalsSessionReason,
    metalsLiquidityReason,
    metalsRejectionReasons,
    priorSessionExtremes: priorExtremes,
    thresholds: {
      MIN_CANDLE_STRENGTH,
      MIN_MARKET_STATE_SCORE,
      MIN_MTF_ALIGNMENT_SCORE,
      MAX_OVEREXTENSION_SCORE,
    },
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
