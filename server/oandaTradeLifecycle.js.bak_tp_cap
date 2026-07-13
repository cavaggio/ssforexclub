import { evaluatePrimaryTimeframeAlignment } from './primaryTimeframeAlignment.js';
/**
 * server/oandaTradeLifecycle.js
 *
 * Dynamic per-trade SL/TP/hold engine. Replaces the previous fixed 20p/60p
 * structure with structure-aware, volatility-aware, key-level-aware targeting.
 *
 *   computeDynamicStopLoss({...}) → { stopLossPips, invalidationReason, ... }
 *   computeDynamicTakeProfit({...}) → { takeProfitPips, riskReward, targetReason, ... }
 *   computeHoldWindow({...})       → { minMinutes, maxMinutes, holdConfidence, ... }
 *   computeTradeProbabilities({...}) → { tpProbability, slProbability }
 *   classifyTradeState({...})      → { tradeState, exitRecommendation, exitReason }
 *
 * Indicators (RSI/MACD) are NOT used here — this engine consumes the macro /
 * structure / momentum / alignment objects from the waterfall and OHLCV.
 *
 *   No auto-execution. The engine returns numbers + reasons; oandaTrade.js and
 *   oandaActiveTradeMonitor.js decide whether to act.
 */

// ─── Hard limits ──────────────────────────────────────────────────────────────
const MIN_SL_PIPS_FOREX  = 12;
const MAX_SL_PIPS_FOREX  = 40;
const MIN_SL_PIPS_JPY    = 14;
const MAX_SL_PIPS_JPY    = 55;
const MIN_SL_PIPS_METALS = 80;
const MAX_SL_PIPS_METALS = 400;

const MIN_RISK_REWARD    = 1.5;   // hard reject below this
const MAX_TP_ATR_MULTIPLE = 5;    // a TP > 5×ATR is not realistic in-session

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPipSize(pair) {
  if (pair.includes('JPY'))                      return 0.01;
  if (pair === 'XAU_USD' || pair === 'XAG_USD')  return 0.01;
  return 0.0001;
}

function isMetalsPair(pair) {
  return pair === 'XAU_USD' || pair === 'XAG_USD';
}

function slBounds(pair) {
  if (isMetalsPair(pair)) return { min: MIN_SL_PIPS_METALS, max: MAX_SL_PIPS_METALS };
  if (pair.includes('JPY')) return { min: MIN_SL_PIPS_JPY, max: MAX_SL_PIPS_JPY };
  return { min: MIN_SL_PIPS_FOREX, max: MAX_SL_PIPS_FOREX };
}

function pricePrecision(pair) {
  if (isMetalsPair(pair))   return 2;
  if (pair.includes('JPY')) return 3;
  return 5;
}

function findRecentSwing(candles, kind, lookback = 20, swingLookback = 2) {
  // kind: 'low' | 'high'. Returns the most recent extreme of the requested kind.
  if (!candles || candles.length < lookback + swingLookback * 2) {
    // Fall back to the simple slice min/max over `lookback`.
    const slice = candles.slice(-lookback);
    if (kind === 'low')  return Math.min(...slice.map(c => c.low));
    return Math.max(...slice.map(c => c.high));
  }
  const range = candles.slice(-(lookback + swingLookback * 2));
  let best = null;
  for (let i = swingLookback; i < range.length - swingLookback; i++) {
    const c = range[i];
    const around = range.slice(i - swingLookback, i + swingLookback + 1);
    if (kind === 'low') {
      const lo = Math.min(...around.map(x => x.low));
      if (c.low === lo) best = c.low;
    } else {
      const hi = Math.max(...around.map(x => x.high));
      if (c.high === hi) best = c.high;
    }
  }
  // Fallback to simple slice if no swing found
  if (best === null) {
    const slice = candles.slice(-lookback);
    if (kind === 'low')  return Math.min(...slice.map(c => c.low));
    return Math.max(...slice.map(c => c.high));
  }
  return best;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PART 2 — DYNAMIC STOP LOSS ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Inputs:
 *   pair, direction ('long'|'short'), entryPrice
 *   atrPips         — M15 ATR in pips
 *   m15Candles      — last 60+ M15 candles
 *   h1Candles       — last 50+ H1 candles (optional, used for swing fallback)
 *   spreadPips
 *   volatilityRegime
 *
 * Returns:
 *   {
 *     stopLossPips, stopLossPrice,
 *     invalidationReason, structureBasedStop, volatilityBufferPips,
 *     atrMultiple,
 *     allowed, rejectionReason
 *   }
 */

function applyPrimaryTimeframeGate(signalLike, direction) {
  const primary = evaluatePrimaryTimeframeAlignment(signalLike, direction);

  if (!signalLike || typeof signalLike !== 'object') return primary;

  signalLike.primaryTimeframeAlignment = primary;

  if (!Array.isArray(signalLike.warnings)) signalLike.warnings = [];
  if (!Array.isArray(signalLike.rejectionReasons)) signalLike.rejectionReasons = [];

  if (!primary.passed) {
    signalLike.rejectionReasons.push(primary.reason);
  } else if (primary.contextConflicts?.length) {
    signalLike.warnings.push(primary.reason);
    signalLike.rejectionReasons = signalLike.rejectionReasons.filter((r) => {
      const s = String(r || '').toLowerCase();
      return !(
        s.includes('alignment score') ||
        s.includes('timeframe score') ||
        s.includes('h1') ||
        s.includes('m30') ||
        s.includes('m5')
      );
    });
  }

  return primary;
}

export function computeDynamicStopLoss({
  pair, direction, entryPrice,
  atrPips, m15Candles, h1Candles,
  spreadPips, volatilityRegime,
  fibonacci,            // NEW — output of detectFibSetup (has swingHigh/swingLow)
  institutionalFlow,    // NEW — output of analyzeInstitutionalFlow (has signals[])
  structureContext,     // NEW — output of analyzeStructure (range / consolidation context)
  marketState,          // NEW — output of classifyMarketState (rules.slMultiplierMin/Max)
  profile,              // NEW — output of getInstrumentProfile (slMultiplier range)
}) {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return { allowed: false, rejectionReason: 'Invalid entry price' };
  }
  const pipSize = getPipSize(pair);
  const { min: minSL, max: maxSL } = slBounds(pair);

  // ── Volatility buffer — at least 2× spread, 30% of ATR, minimum 3 pips ──
  // Tightened or widened by market-state and instrument-profile rules.
  //   marketState.rules.slMultiplierMax  bumps the ATR component for VOLATILE
  //   profile.slMultiplier[1]            bumps it for metals/indices vs forex
  const stateSlMax    = marketState?.rules?.slMultiplierMax || 1.0;
  const profileSlMax  = Array.isArray(profile?.slMultiplier) ? profile.slMultiplier[1] : 1.0;
  const slWidenMult   = Math.max(stateSlMax, profileSlMax, 1.0);
  const safeSpread = Number.isFinite(spreadPips) ? spreadPips : 1;
  const atrBuffer = Math.max(
    3,
    Math.round(safeSpread * 2),
    Math.round((atrPips || 0) * 0.3 * slWidenMult),
  );

  // ── Build candidate "protective" levels from every available structure ────
  // For a long we want the price level BELOW entry that, if broken, invalidates
  // the trade thesis. We then add the ATR buffer to sit *below* (not at) that
  // level so a routine wick can't take us out. For a short, the inverse.
  const candidates = [];   // { source, rawLevel, finalStop, distancePips }

  function pushCandidate(source, rawLevel) {
    if (!Number.isFinite(rawLevel)) return;
    const finalStop = direction === 'long'
      ? rawLevel - atrBuffer * pipSize
      : rawLevel + atrBuffer * pipSize;
    const distancePips = Math.abs(entryPrice - finalStop) / pipSize;
    // For longs: only accept levels strictly BELOW entry (otherwise the "stop"
    // would sit at or above entry — meaningless). For shorts: strictly ABOVE.
    const valid = direction === 'long'
      ? rawLevel < entryPrice
      : rawLevel > entryPrice;
    if (!valid) return;
    candidates.push({ source, rawLevel, finalStop, distancePips });
  }

  // 1. M15 swing (recent micro-structure)
  if (m15Candles && m15Candles.length >= 10) {
    const extremeM15 = findRecentSwing(m15Candles, direction === 'long' ? 'low' : 'high', 20);
    pushCandidate('m15_swing', extremeM15);
  }
  // 2. H1 swing (broader structure — preferred)
  if (h1Candles && h1Candles.length >= 10) {
    const extremeH1 = findRecentSwing(h1Candles, direction === 'long' ? 'low' : 'high', 20);
    pushCandidate('h1_swing', extremeH1);
  }
  // 3. Liquidity-sweep extreme — if a sweep fired in the trade direction, the
  //    swept level itself is the strongest invalidation (institutions defend it).
  if (institutionalFlow && Array.isArray(institutionalFlow.signals)) {
    const tradeSign = direction === 'long' ? 'bullish' : 'bearish';
    const sweep = institutionalFlow.signals.find(
      s => s.type === 'liquidity_sweep' && s.direction === tradeSign
    );
    if (sweep && Number.isFinite(sweep.sweptPriceLevel)) {
      // For a bullish sweep (longs), the swept level is the run-low itself.
      // Place SL just beyond that — i.e. at sweptPriceLevel − buffer for long.
      // But sweptPriceLevel was the level that got pierced, so use it directly.
      pushCandidate('liquidity_sweep', sweep.sweptPriceLevel);
    }
  }
  // 4. Fibonacci impulse origin — full retracement = thesis invalidated.
  if (fibonacci && fibonacci.enabled && fibonacci.entryZoneStatus !== 'unknown') {
    const impulseOrigin = direction === 'long' ? fibonacci.swingLow : fibonacci.swingHigh;
    pushCandidate('fib_impulse_origin', impulseOrigin);
  }
  // 5. Range boundary — if consolidation, place SL just outside the range.
  //    structureContext is the analyzeStructure() output; we don't have an
  //    explicit range field, but the nearKeyLevel info gives us the closest
  //    H4 barrier on the opposite side of entry.
  // (We rely on the H1/M15 swings to capture range boundaries in practice;
  //  this hook is here for an explicit range field in future iterations.)
  void structureContext;

  // ── Choose the most protective candidate that fits inside max SL bounds ──
  // "Most protective" = the candidate with the largest distance from entry,
  // because a wider SL means more room before invalidation. If none fits,
  // fall back to the closest one (capped at maxSL anyway).
  candidates.sort((a, b) => b.distancePips - a.distancePips);
  const withinBounds = candidates.find(c => c.distancePips <= maxSL && c.distancePips >= minSL);
  const chosen = withinBounds || candidates[0] || null;

  let structureBasedStop = chosen ? chosen.finalStop : null;
  let invalidationReason = '';
  let structureSource = chosen ? chosen.source : null;

  if (chosen) {
    const levelStr = chosen.rawLevel.toFixed(pricePrecision(pair));
    const labelMap = {
      m15_swing: 'M15 swing',
      h1_swing: 'H1 swing',
      liquidity_sweep: 'liquidity-sweep extreme',
      fib_impulse_origin: 'Fib impulse origin',
    };
    invalidationReason =
      `${labelMap[chosen.source] || chosen.source} ${levelStr} ${direction === 'long' ? '−' : '+'} ${atrBuffer}p ATR buffer`;
  }

  // Compute raw SL pips from the chosen stop
  let rawSlPips;
  if (structureBasedStop !== null) {
    rawSlPips = Math.abs(entryPrice - structureBasedStop) / pipSize;
  } else {
    // Fallback: ATR × 1.2 + buffer
    rawSlPips = (atrPips || 15) * 1.2 + atrBuffer;
    invalidationReason = `No structural swing — ATR×1.2 + ${atrBuffer}p buffer`;
    structureSource = 'atr_fallback';
  }

  // Compressed volatility → cap SL closer to avoid noise stops in flat market
  if (volatilityRegime === 'compressed' && atrPips && rawSlPips > atrPips * 2) {
    rawSlPips = Math.max(minSL, atrPips * 2);
    invalidationReason += ' (compressed-vol cap)';
  }

  // Clamp to allowed bounds
  let stopLossPips = Math.round(rawSlPips);
  let rejectionReason = null;
  if (stopLossPips > maxSL) {
    rejectionReason = `Required SL ${stopLossPips}p exceeds max ${maxSL}p — invalidation is too far for risk model`;
  }
  stopLossPips = Math.min(maxSL, Math.max(minSL, stopLossPips));

  const stopLossPrice = direction === 'long'
    ? +(entryPrice - stopLossPips * pipSize).toFixed(pricePrecision(pair))
    : +(entryPrice + stopLossPips * pipSize).toFixed(pricePrecision(pair));

  return {
    allowed: rejectionReason === null,
    rejectionReason,
    stopLossPips,
    stopLossPrice,
    invalidationReason,
    structureBasedStop: structureBasedStop !== null
      ? +structureBasedStop.toFixed(pricePrecision(pair))
      : null,
    volatilityBufferPips: atrBuffer,
    atrMultiple: atrPips > 0 ? +(stopLossPips / atrPips).toFixed(2) : null,
    // Structure-aware audit block (NEW — spec'd in task 7 of upgrade)
    stopLossAnalysis: {
      structureLevel: chosen ? +chosen.rawLevel.toFixed(pricePrecision(pair)) : null,
      structureSource,
      atrBuffer,
      finalStopLoss: stopLossPrice,
      candidatesConsidered: candidates.map(c => ({
        source: c.source,
        rawLevel: +c.rawLevel.toFixed(pricePrecision(pair)),
        distancePips: +c.distancePips.toFixed(1),
      })),
      reason: invalidationReason,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PART 1 — DYNAMIC TAKE PROFIT ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Computes a realistic TP from stop distance + market context.
 *
 *   Base R:R chosen from `Primary timeframe alignment failed: Daily + H4 + M15 must align. H1/M30/M5 are context only.`MAX_TP_ATR_MULTIPLE * atrPips`
 *     TP cannot reach within 4 pips of the next unbroken H4 key level
 */
export function computeDynamicTakeProfit({
  pair, direction, entryPrice,
  stopLossPips, atrPips,
  alignment, macro, structure, momentum,
  spreadPips, maxSpreadPips, session,
  marketState,    // NEW — output of classifyMarketState (rules.tpMultiplierMin/Max)
  profile,        // NEW — output of getInstrumentProfile (tpMultiplier + maxSpreadPctOfTp)
  candleStrength, // NEW — output of analyzeCandleStrength (penalizes TP when candle is weak)
}) {
  if (!stopLossPips || stopLossPips <= 0) {
    return { allowed: false, rejectionReason: 'Stop loss not computed' };
  }
  const pipSize = getPipSize(pair);
  const alignScore = alignment?.timeframeAlignmentScore || 0;

  let baseRR;
  let targetReason;
  if      (alignScore >= 80) { baseRR = 3.0; targetReason = `Strong alignment (${alignScore}/100) → 3R target`; }
  else if (alignScore >= 65) { baseRR = 2.5; targetReason = `Good alignment (${alignScore}/100) → 2.5R target`; }
  else if (alignScore >= 55) { baseRR = 2.0; targetReason = `Moderate alignment (${alignScore}/100) → 2R target`; }
  else                       { baseRR = 1.5; targetReason = `Weak alignment (${alignScore}/100) → 1.5R cap`; }

  let rrMultipliers = [];

  if (macro?.volatilityRegime === 'expanded')   { baseRR *= 1.20; rrMultipliers.push('expanded-vol×1.20'); }
  if (macro?.volatilityRegime === 'compressed') { baseRR *= 0.80; rrMultipliers.push('compressed-vol×0.80'); }
  if (momentum?.executionConfirmation === 'partial') { baseRR *= 0.85; rrMultipliers.push('partial-confirm×0.85'); }
  if (structure?.reversalRisk === 'medium')     { baseRR *= 0.85; rrMultipliers.push('reversal-medium×0.85'); }
  if (structure?.reversalRisk === 'high')       { baseRR *= 0.70; rrMultipliers.push('reversal-high×0.70'); }

  const lowLiquiditySession = session === 'Sydney' || session === 'Sydney/Tokyo Overlap' || session === 'Tokyo';
  if (lowLiquiditySession)                      { baseRR *= 0.85; rrMultipliers.push('low-liquidity×0.85'); }

  // Wide spread eats into TP — pull the target in
  if (spreadPips && maxSpreadPips && spreadPips / maxSpreadPips > 0.7) {
    baseRR *= 0.90;
    rrMultipliers.push('wide-spread×0.90');
  }

  // Market-state-aware TP — RANGING/CHOPPY pulls TP in, BREAKOUT extends.
  // We clamp baseRR to the state-suggested TP-multiplier band.
  if (marketState?.rules) {
    const minM = marketState.rules.tpMultiplierMin ?? 1.5;
    const maxM = marketState.rules.tpMultiplierMax ?? 3.5;
    if (baseRR < minM) { baseRR = minM; rrMultipliers.push(`state-${marketState.marketState}-floor`); }
    if (baseRR > maxM) { baseRR = maxM; rrMultipliers.push(`state-${marketState.marketState}-cap`); }
  }

  // Instrument-profile band — metals/indices need different TP envelopes
  if (Array.isArray(profile?.tpMultiplier)) {
    const [profMin, profMax] = profile.tpMultiplier;
    if (baseRR < profMin) { baseRR = profMin; rrMultipliers.push('profile-floor'); }
    if (baseRR > profMax) { baseRR = profMax; rrMultipliers.push('profile-cap'); }
  }

  // Weak candle close → pull TP in by 15% (a weak entry can't realistically
  // capture a stretched target)
  if (candleStrength && candleStrength.candleStrengthScore < 35 && baseRR > 1.6) {
    baseRR *= 0.85;
    rrMultipliers.push(`weak-candle×0.85`);
  }

  // Initial TP from R:R
  let takeProfitPips = Math.round(stopLossPips * baseRR);

  // ── ATR realism cap ─────────────────────────────────────────────────────
  let cappedByAtr = false;
  if (atrPips && takeProfitPips > atrPips * MAX_TP_ATR_MULTIPLE) {
    takeProfitPips = Math.round(atrPips * MAX_TP_ATR_MULTIPLE);
    cappedByAtr = true;
    rrMultipliers.push(`ATR-cap×${MAX_TP_ATR_MULTIPLE}`);
  }

  // ── Key level cap ───────────────────────────────────────────────────────
  // Don't blindly TP through unbroken H4 support/resistance — cap 4p before it.
  let cappedByKeyLevel = false;
  let keyLevelDistance = null;
  if (macro?.keyLevels && macro.keyLevels.length) {
    const tpPrice = direction === 'long'
      ? entryPrice + takeProfitPips * pipSize
      : entryPrice - takeProfitPips * pipSize;
    const blockingLevels = macro.keyLevels.filter(lvl => {
      if (direction === 'long')  return lvl.kind === 'resistance' && lvl.price > entryPrice && lvl.price <= tpPrice;
      if (direction === 'short') return lvl.kind === 'support'    && lvl.price < entryPrice && lvl.price >= tpPrice;
      return false;
    });
    if (blockingLevels.length) {
      const nearestBlocker = direction === 'long'
        ? blockingLevels.reduce((a, b) => a.price < b.price ? a : b)
        : blockingLevels.reduce((a, b) => a.price > b.price ? a : b);
      const distToBlocker = Math.abs(nearestBlocker.price - entryPrice) / pipSize;
      keyLevelDistance = +distToBlocker.toFixed(1);
      const cappedTpPips = Math.max(0, Math.round(distToBlocker - 4));   // 4p buffer
      if (cappedTpPips < takeProfitPips) {
        takeProfitPips  = cappedTpPips;
        cappedByKeyLevel = true;
        rrMultipliers.push(`key-level-cap@${keyLevelDistance}p`);
      }
    }
  }

  // Compute final R:R and decide whether to accept
  const riskReward = +(takeProfitPips / stopLossPips).toFixed(2);
  let allowed = true;
  let rejectionReason = null;
  if (riskReward < MIN_RISK_REWARD) {
    allowed = false;
    rejectionReason = cappedByKeyLevel
      ? `TP capped by H4 key level at ${keyLevelDistance}p — final R:R ${riskReward} < min ${MIN_RISK_REWARD}`
      : `Final R:R ${riskReward} < min ${MIN_RISK_REWARD}`;
  }

  // Spread / TP ratio gate (Task 8). If the spread eats more than the
  // instrument-profile-allowed fraction of TP, the trade is mathematically
  // unfavourable — even a winning move spends most of the gain crossing the
  // spread. Profile.maxSpreadPctOfTp defaults to 0.20 for major forex,
  // 0.15 for indices, 0.22 for AUD/USD-like spreads.
  if (allowed && spreadPips != null && Number.isFinite(spreadPips) && takeProfitPips > 0) {
    const maxPct = profile?.maxSpreadPctOfTp ?? 0.25;
    const ratio = spreadPips / takeProfitPips;
    if (ratio > maxPct) {
      allowed = false;
      rejectionReason =
        `Spread too high relative to TP: ${spreadPips}p / ${takeProfitPips}p = ` +
        `${(ratio * 100).toFixed(0)}% > ${(maxPct * 100).toFixed(0)}% profile cap`;
    }
  }

  const takeProfitPrice = direction === 'long'
    ? +(entryPrice + takeProfitPips * pipSize).toFixed(pricePrecision(pair))
    : +(entryPrice - takeProfitPips * pipSize).toFixed(pricePrecision(pair));

  // Plain-English TP/SL reason that combines all the modifiers
  const tpSlReason =
    `${targetReason}` +
    (rrMultipliers.length ? ` [${rrMultipliers.join(', ')}]` : '') +
    (marketState ? ` · state=${marketState.marketState}` : '') +
    (profile ? ` · profile=${profile.assetClass}` : '');

  return {
    allowed,
    rejectionReason,
    takeProfitPips,
    takeProfitPrice,
    riskReward,
    targetReason: `${targetReason}${rrMultipliers.length ? ' [' + rrMultipliers.join(', ') + ']' : ''}`,
    rrMultipliers,
    cappedByKeyLevel,
    cappedByAtr,
    keyLevelDistance,
    tpSlReason,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PART 3 — DYNAMIC HOLD WINDOW
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Estimate min/max minutes until TP can plausibly be reached.
 *
 *   pipsPerMinute = avg(last 10 M15 candle ranges) / 15
 *   base_minutes  = takeProfitPips / pipsPerMinute
 *
 * Adjust for session (NY/London overlap faster, Sydney slower) and momentum.
 */
export function computeHoldWindow({
  takeProfitPips, m15Candles,
  session, momentum, macro,
}) {
  if (!takeProfitPips || takeProfitPips <= 0) {
    return { minMinutes: 0, maxMinutes: 0, holdConfidence: 0, timeToTPReason: 'no TP' };
  }

  // Pip velocity from M15 candle ranges
  const lookback = 10;
  let avgRangePips = 0;
  if (m15Candles && m15Candles.length >= lookback) {
    const recent = m15Candles.slice(-lookback);
    const pipSize = getPipSize(m15Candles[0].instrument || ''); // fallback below
    // We can't reliably get pair from candle; fall back to using ATR proxy
    const sumRange = recent.reduce((s, c) => s + (c.high - c.low), 0);
    avgRangePips = (sumRange / lookback) / (pipSize || (recent[0].high > 50 ? 0.01 : 0.0001));
  }
  if (!avgRangePips || avgRangePips < 0.5) avgRangePips = Math.max(1, momentum?.atrPips * 0.4 || 4);

  const pipsPerMinute = avgRangePips / 15;
  let baseMinutes = takeProfitPips / pipsPerMinute;

  // Session adjustment
  let sessionMult = 1.0;
  if (session === 'London/NewYork Overlap') sessionMult = 0.80;
  else if (session === 'London' || session === 'NewYork') sessionMult = 0.95;
  else if (session === 'Tokyo/London Overlap') sessionMult = 1.05;
  else if (session === 'Tokyo') sessionMult = 1.30;
  else if (session === 'Sydney' || session === 'Sydney/Tokyo Overlap') sessionMult = 1.60;

  // Momentum adjustment
  const momStrength = momentum?.momentumStrength || 50;
  let momentumMult = 1.0;
  if (momStrength >= 75) momentumMult = 0.80;
  else if (momStrength >= 50) momentumMult = 1.00;
  else momentumMult = 1.30;

  // Volatility regime
  let volMult = 1.0;
  if (macro?.volatilityRegime === 'expanded') volMult = 0.85;
  if (macro?.volatilityRegime === 'compressed') volMult = 1.40;

  baseMinutes = baseMinutes * sessionMult * momentumMult * volMult;

  let minMinutes = Math.max(15, Math.round(baseMinutes * 0.7));
  let maxMinutes = Math.min(720, Math.round(baseMinutes * 1.6));
  if (minMinutes > maxMinutes) maxMinutes = minMinutes + 15;

  // Confidence in the window estimate
  let holdConfidence = 60;
  if (momStrength >= 75) holdConfidence += 15;
  if (macro?.volatilityRegime === 'expanded') holdConfidence += 5;
  if (macro?.volatilityRegime === 'compressed') holdConfidence -= 15;
  if (session === 'Sydney' || session === 'Sydney/Tokyo Overlap') holdConfidence -= 10;
  holdConfidence = Math.max(0, Math.min(100, holdConfidence));

  return {
    minMinutes,
    maxMinutes,
    holdConfidence,
    avgRangePips: +avgRangePips.toFixed(2),
    pipsPerMinute: +pipsPerMinute.toFixed(3),
    timeToTPReason:
      `TP ${takeProfitPips}p ÷ ${pipsPerMinute.toFixed(2)}p/min × ` +
      `session=${sessionMult.toFixed(2)} × momentum=${momentumMult.toFixed(2)} × vol=${volMult.toFixed(2)}`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PART 3b — TP/SL PROBABILITY
// ═══════════════════════════════════════════════════════════════════════════════
export function computeTradeProbabilities({
  alignment, macro, structure, momentum, riskReward,
}) {
  let tpProb = 0.55;   // baseline (slightly above 50/50 because we require alignment)
  const alignScore = alignment?.timeframeAlignmentScore || 0;

  if (alignScore >= 80) tpProb += 0.12;
  else if (alignScore >= 65) tpProb += 0.06;
  else if (alignScore < 55)  tpProb -= 0.08;

  if (structure?.structureAligned) tpProb += 0.04;
  if (momentum?.executionConfirmation === 'full') tpProb += 0.04;
  if (momentum?.executionConfirmation === 'partial') tpProb -= 0.04;

  if (structure?.reversalRisk === 'medium') tpProb -= 0.10;
  if (structure?.reversalRisk === 'high')   tpProb -= 0.20;

  if (macro?.volatilityRegime === 'compressed') tpProb -= 0.05;
  if (macro?.volatilityRegime === 'expanded')   tpProb += 0.03;

  // The higher the R:R the less likely TP fires (more ground to cover).
  if (riskReward >= 3) tpProb -= 0.05;
  if (riskReward >= 4) tpProb -= 0.05;

  tpProb = Math.max(0.20, Math.min(0.85, tpProb));
  return {
    tpProbability: +tpProb.toFixed(2),
    slProbability: +(1 - tpProb).toFixed(2),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PART 4 — ACTIVE TRADE STATE CLASSIFIER + EXIT RECOMMENDATION
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Inputs:
 *   side ('long'|'short')
 *   entryPrice, currentPrice, stopLoss, takeProfit
 *   currentWaterfall: { macro, structure, momentum, alignment }
 *   entryAlignmentScore — original alignment when trade was opened (optional)
 *   minutesElapsed
 *   holdWindow: { minMinutes, maxMinutes }
 *
 * Returns:
 *   {
 *     tradeState, exitRecommendation, exitReason,
 *     distanceToTPPips, distanceToSLPips,
 *     timeDecayRisk,
 *     unrealizedPips,
 *     tpProgress (0..1)
 *   }
 */
export function classifyTradeState({
  pair, side, entryPrice, currentPrice, stopLoss, takeProfit,
  currentWaterfall, entryAlignmentScore = null,
  minutesElapsed = 0, holdWindow = null,
}) {
  const pipSize = getPipSize(pair);
  const { macro, structure, momentum, alignment } = currentWaterfall || {};

  const unrealizedPips = side === 'long'
    ? (currentPrice - entryPrice) / pipSize
    : (entryPrice - currentPrice) / pipSize;
  const distanceToTPPips = side === 'long'
    ? (takeProfit - currentPrice) / pipSize
    : (currentPrice - takeProfit) / pipSize;
  const distanceToSLPips = side === 'long'
    ? (currentPrice - stopLoss) / pipSize
    : (stopLoss - currentPrice) / pipSize;

  const totalTpPips = Math.abs(takeProfit - entryPrice) / pipSize;
  const tpProgress = totalTpPips > 0
    ? Math.max(0, Math.min(1, unrealizedPips / totalTpPips))
    : 0;

  const tradeSide = side === 'long' ? 'bullish' : 'bearish';
  const macroOpposes =
    (side === 'long'  && macro?.macroBias === 'bearish') ||
    (side === 'short' && macro?.macroBias === 'bullish');
  const conflictingTfCount = alignment?.conflictingTimeframes?.length || 0;
  const alignmentDropped = entryAlignmentScore !== null
    && alignment?.timeframeAlignmentScore !== undefined
    && (entryAlignmentScore - alignment.timeframeAlignmentScore) >= 20;
  const reversalHigh = structure?.reversalRisk === 'high';

  // Time decay
  let timeDecayRisk = 'low';
  if (holdWindow && minutesElapsed) {
    const pastMin = minutesElapsed > holdWindow.minMinutes;
    const pastMax = minutesElapsed > holdWindow.maxMinutes;
    if (pastMax && tpProgress < 0.5) timeDecayRisk = 'high';
    else if (pastMin && tpProgress < 0.4) timeDecayRisk = 'medium';
  }

  // ── Trade state ──────────────────────────────────────────────────────────
  let tradeState;
  if (macroOpposes && conflictingTfCount >= 3) {
    tradeState = 'INVALIDATED';
  } else if (macroOpposes || conflictingTfCount >= 4) {
    tradeState = 'EXIT_RECOMMENDED';
  } else if (reversalHigh) {
    tradeState = 'REVERSAL_RISK';
  } else if (tpProgress >= 0.7 && distanceToTPPips < totalTpPips * 0.3) {
    tradeState = 'TP_LIKELY';
  } else if (alignmentDropped || (momentum?.executionConfidence ?? 0) < 30) {
    tradeState = 'WEAKENING';
  } else if (timeDecayRisk !== 'low' && tpProgress < 0.4) {
    tradeState = 'STALLING';
  } else if ((momentum?.momentumStrength ?? 0) >= 70 && unrealizedPips > 0) {
    tradeState = 'ACCELERATING';
  } else {
    tradeState = 'OPEN_HEALTHY';
  }

  // ── Exit recommendation ──────────────────────────────────────────────────
  let exitRecommendation = 'HOLD';
  let exitReason = 'Trade thesis intact';
  switch (tradeState) {
    case 'INVALIDATED':
      exitRecommendation = 'CLOSE_IMMEDIATELY';
      exitReason = `Macro flipped to ${macro?.macroBias} against ${side} side with ${conflictingTfCount} TF conflicts`;
      break;
    case 'EXIT_RECOMMENDED':
      exitRecommendation = 'CLOSE_TRADE';
      exitReason = macroOpposes
        ? `Macro now ${macro?.macroBias} — opposes ${side} side`
        : `${conflictingTfCount} timeframes conflict with side`;
      break;
    case 'REVERSAL_RISK':
      exitRecommendation = unrealizedPips > 0 ? 'TAKE_PARTIAL_PROFIT' : 'HOLD_WITH_CAUTION';
      exitReason = `Structure reversal risk HIGH (near unbroken H4 level)`;
      break;
    case 'TP_LIKELY':
      exitRecommendation = 'TRAIL_STOP';
      exitReason = `TP within reach (${tpProgress.toFixed(2)} of distance covered) — trail stop`;
      break;
    case 'WEAKENING':
      exitRecommendation = unrealizedPips > 0 ? 'MOVE_STOP_TO_BREAKEVEN' : 'HOLD_WITH_CAUTION';
      exitReason = alignmentDropped
        ? `Alignment dropped from ${entryAlignmentScore} to ${alignment?.timeframeAlignmentScore}`
        : `Execution confidence dropped to ${momentum?.executionConfidence}`;
      break;
    case 'STALLING':
      exitRecommendation = 'HOLD_WITH_CAUTION';
      exitReason = `Hold window past ${minutesElapsed}min but TP progress only ${(tpProgress*100).toFixed(0)}%`;
      break;
    case 'ACCELERATING':
      exitRecommendation = 'TRAIL_STOP';
      exitReason = `Momentum strong (${momentum?.momentumStrength}), P/L positive — trail to lock gains`;
      break;
    default:   // OPEN_HEALTHY
      exitRecommendation = 'HOLD';
      exitReason = `Aligned with thesis (align ${alignment?.timeframeAlignmentScore}/100)`;
  }

  // Map the existing exitRecommendation vocabulary to the user-spec'd review
  // action set (Task 9): HOLD | TIGHTEN_SL | REDUCE_TP | EXIT_REVIEW | INVALIDATED.
  // The original exitRecommendation field is preserved for any existing
  // consumers (the dashboard reads it directly).
  let reviewAction;
  switch (tradeState) {
    case 'INVALIDATED':         reviewAction = 'INVALIDATED'; break;
    case 'EXIT_RECOMMENDED':    reviewAction = 'EXIT_REVIEW'; break;
    case 'REVERSAL_RISK':       reviewAction = unrealizedPips > 0 ? 'TIGHTEN_SL' : 'EXIT_REVIEW'; break;
    case 'TP_LIKELY':           reviewAction = 'TIGHTEN_SL'; break;
    case 'WEAKENING':           reviewAction = unrealizedPips > 0 ? 'TIGHTEN_SL' : 'EXIT_REVIEW'; break;
    case 'STALLING':            reviewAction = 'REDUCE_TP'; break;
    case 'ACCELERATING':        reviewAction = 'TIGHTEN_SL'; break;
    default:                     reviewAction = 'HOLD';
  }

  return {
    tradeState,
    exitRecommendation,
    exitReason,
    reviewAction,                  // NEW — Task 9
    distanceToTPPips: +distanceToTPPips.toFixed(1),
    distanceToSLPips: +distanceToSLPips.toFixed(1),
    unrealizedPips: +unrealizedPips.toFixed(1),
    tpProgress: +tpProgress.toFixed(2),
    timeDecayRisk,
    minutesElapsed,
    macroOpposes,
    conflictingTfCount,
    alignmentDropped,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Top-level orchestrator used by the scanner: full lifecycle for a NEW trade.
// ═══════════════════════════════════════════════════════════════════════════════
export function computeTradeLifecycle({
  pair, direction, entryPrice,
  atrPips, m15Candles, h1Candles,
  spreadPips, maxSpreadPips, session,
  macro, structure, momentum, alignment,
  fibonacci, institutionalFlow,        // for structure-aware SL
  marketState, profile, candleStrength, // NEW — Task 4/7/8
}) {
  const sl = computeDynamicStopLoss({
    pair, direction, entryPrice,
    atrPips, m15Candles, h1Candles,
    spreadPips,
    volatilityRegime: macro?.volatilityRegime,
    fibonacci,
    institutionalFlow,
    structureContext: structure,
    marketState, profile,
  });
  if (!sl.allowed) return { allowed: false, rejectionReason: sl.rejectionReason, sl };

  const tp = computeDynamicTakeProfit({
    pair, direction, entryPrice,
    stopLossPips: sl.stopLossPips,
    atrPips,
    alignment, macro, structure, momentum,
    spreadPips, maxSpreadPips, session,
    marketState, profile, candleStrength,
  });
  if (!tp.allowed) return { allowed: false, rejectionReason: tp.rejectionReason, sl, tp };

  const hold = computeHoldWindow({
    takeProfitPips: tp.takeProfitPips,
    m15Candles, session, momentum, macro,
  });

  const probs = computeTradeProbabilities({
    alignment, macro, structure, momentum, riskReward: tp.riskReward,
  });

  // Combined human-readable reason for the dashboard
  const tpSlReason = [
    tp.tpSlReason,
    sl.invalidationReason ? `SL: ${sl.invalidationReason}` : null,
    marketState?.marketStateReason ? `state: ${marketState.marketStateReason}` : null,
  ].filter(Boolean).join(' | ');

  return {
    allowed: true,
    sl, tp, hold, probs,
    momentumPersistence: momentum?.momentumStrength ?? 0,
    volatilityPersistence:
      macro?.volatilityRegime === 'expanded' ? 'high' :
      macro?.volatilityRegime === 'compressed' ? 'low' : 'normal',
    // Convenience top-level mirrors for the dashboard / consumer code
    recommendedStopLoss:    sl.stopLossPrice,
    recommendedTakeProfit:  tp.takeProfitPrice,
    riskRewardRatio:        tp.riskReward,
    expectedHoldTimeMinutes:Math.round((hold.minMinutes + hold.maxMinutes) / 2),
    tpSlReason,
  };
}
