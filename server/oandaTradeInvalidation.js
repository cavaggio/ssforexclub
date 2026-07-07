import { evaluatePrimaryTimeframeAlignment } from './primaryTimeframeAlignment.js';
/**
 * server/oandaTradeInvalidation.js
 *
 * THESIS-BREAKING checks for active trades.
 *
 *   detectInvalidation(ctx)         → Part 6
 *   detectVolatilityCollapse(ctx)   → Part 4
 *   detectTrendWeakening(ctx)       → Part 7
 *
 * Each returns a normalized {detected, severity, reason, signals} envelope
 * — the orchestrator decides priority (invalidation > volatility collapse >
 * trend weakening).
 */

import { ema } from './oandaIndicators.js';

function getPipSize(pair) {
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return 0.01;
  if (pair && /^(NAS100|US30|SPX500|DE30|UK100)/.test(pair)) return 1.0;
  if (pair && pair.includes('JPY')) return 0.01;
  return 0.0001;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PART 6 — INVALIDATION
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Hard / soft invalidation conditions. Severity ladder:
 *   'low'    — single weak signal, monitor
 *   'medium' — two signals OR one structural break
 *   'high'   — HTF flip OR key-swing break OR opposing sweep + thesis broken
 *
 * Inputs (current waterfall + entry context):
 *   macroNow, structureNow, mtfAuthorityNow, candleStrengthNow, institutionalFlow,
 *   entryAssetClass, side, entryPrice, currentPrice, pair,
 *   originalSL, expectedHoldTimeMinutes, minutesElapsed, pricing, atrPipsCurrent
 *   entryContext: { mtfAuthorityScore, marketState, candleStrengthScore, atrPips, … }
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

export function detectInvalidation({
  side, entryPrice, currentPrice, originalSL, pair,
  macroNow, structureNow, mtfAuthorityNow, candleStrengthNow,
  institutionalFlow, marketStateNow,
  entryContext, expectedHoldTimeMinutes, minutesElapsed,
  pricing, atrPipsCurrent,
}) {
  const signals = [];
  let severity = 'low';

  const tradeSign = side === 'long' ? 'bullish' : 'bearish';
  const oppositeSign = side === 'long' ? 'bearish' : 'bullish';

  // 1. HTF bias flip — current macro is opposite to entry direction
  const macroNowBias = macroNow?.macroBias;
  const htfOpposes =
    (side === 'long'  && macroNowBias === 'bearish') ||
    (side === 'short' && macroNowBias === 'bullish');
  if (htfOpposes) {
    signals.push('HTF bias flipped against trade direction');
    severity = 'high';
  }

  // 2. MTF authority — current AlignmentScore dropped meaningfully OR conflict
  const mtfNow = mtfAuthorityNow?.multiTimeframeAlignmentScore ?? null;
  const mtfEntry = entryContext?.entryMtfAlignmentScore ?? null;
  if (mtfAuthorityNow?.conflict) {
    signals.push('MTF authority reports hard conflict between TFs');
    severity = severity === 'high' ? severity : 'high';
  } else if (mtfEntry != null && mtfNow != null && (mtfEntry - mtfNow) >= 20) {
    signals.push(`MTF alignment dropped ${mtfEntry - mtfNow} points since entry (${mtfEntry}→${mtfNow})`);
    if (severity === 'low') severity = 'medium';
  }

  // 3. Key swing-level break — for longs, did price close below the swing low
  //    that anchored the entry (proxy: any close below originalSL−0p means SL
  //    already hit). Better signal: nearKeyLevel info from structureNow.
  const nearKeyAgainst = structureNow?.nearKeyLevel;
  if (nearKeyAgainst &&
      ((side === 'long' && nearKeyAgainst.kind === 'support' && structureNow.reversalRisk === 'high') ||
       (side === 'short' && nearKeyAgainst.kind === 'resistance' && structureNow.reversalRisk === 'high'))) {
    signals.push(`Price ${nearKeyAgainst.distancePips}p from unbroken H4 ${nearKeyAgainst.kind} with HIGH reversal risk`);
    if (severity !== 'high') severity = 'medium';
  }

  // 4. Liquidity sweep / failed breakout in OPPOSITE direction
  const opposingSweep = (institutionalFlow?.signals || []).find(
    s => (s.type === 'liquidity_sweep' || s.subtype === 'failed_breakout') &&
         s.direction === oppositeSign
  );
  if (opposingSweep) {
    signals.push(`Opposing ${opposingSweep.subtype === 'failed_breakout' ? 'failed breakout' : 'liquidity sweep'}: ${opposingSweep.reason}`);
    severity = 'high';
  }

  // 5. Candle rejection strongly opposes
  if (candleStrengthNow?.classification === 'rejection') {
    const rejAgainst =
      (side === 'long' && (candleStrengthNow.components?.upperWick ?? 0) > (candleStrengthNow.components?.lowerWick ?? 0)) ||
      (side === 'short' && (candleStrengthNow.components?.lowerWick ?? 0) > (candleStrengthNow.components?.upperWick ?? 0));
    if (rejAgainst) {
      signals.push(`Rejection candle against trade: ${candleStrengthNow.reason}`);
      if (severity === 'low') severity = 'medium';
    }
  }

  // 6. Market state shifted to REVERSAL_RISK
  if (marketStateNow?.marketState === 'REVERSAL_RISK') {
    signals.push(`Market state shifted to REVERSAL_RISK: ${marketStateNow.marketStateReason}`);
    if (severity === 'low') severity = 'medium';
  }

  // 7. Stagnation — trade idle > 2× expected hold time and no progress
  if (Number.isFinite(expectedHoldTimeMinutes) && expectedHoldTimeMinutes > 0 &&
      Number.isFinite(minutesElapsed) && minutesElapsed > expectedHoldTimeMinutes * 2) {
    const pipSize = getPipSize(pair);
    const profitPips = side === 'long'
      ? (currentPrice - entryPrice) / pipSize
      : (entryPrice - currentPrice) / pipSize;
    if (profitPips <= 0) {
      signals.push(`Trade stagnant: ${minutesElapsed}min > 2× expected hold (${expectedHoldTimeMinutes}min) with no profit`);
      if (severity === 'low') severity = 'medium';
    }
  }

  // 8. Spread expanded abnormally — TP no longer realistic
  const baselineSpread = entryContext?.entrySpreadPips ?? null;
  const currentSpread = pricing?.spreadPips ?? null;
  if (Number.isFinite(baselineSpread) && Number.isFinite(currentSpread) &&
      baselineSpread > 0 && currentSpread / baselineSpread >= 3) {
    signals.push(`Spread tripled since entry (${baselineSpread}p → ${currentSpread}p)`);
    if (severity === 'low') severity = 'medium';
  }

  const detected = signals.length > 0 && (severity === 'high' || severity === 'medium');
  return {
    invalidationDetected: detected,
    invalidationSeverity: severity,
    exitInvalidatedRecommended: severity === 'high',
    invalidationReason: detected
      ? `Trade invalidated by ${signals.length} signal${signals.length === 1 ? '' : 's'}: ${signals.join(' · ')}`
      : signals.length
        ? `Watching ${signals.length} early signal(s) — not yet invalidating: ${signals.join(' · ')}`
        : 'Trade thesis intact',
    signals,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PART 4 — VOLATILITY COLLAPSE
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Detect that volatility has materially dropped after entry. We compare:
 *   atrPipsCurrent vs entryContext.entryATR (if stored)
 *   recent candle ranges vs entry-time ranges
 *   marketStateNow vs entryMarketState
 *
 * Severity:
 *   'low'    — minor compression
 *   'medium' — ratio < 0.7 OR state shifted to LOW_LIQUIDITY/RANGING
 *   'high'   — ratio < 0.5 OR state shifted to CHOPPY + tpProgress < 0.3
 */
export function detectVolatilityCollapse({
  pair, marketStateNow, atrPipsCurrent, entryContext, m15Candles,
  tpProgress,
}) {
  const entryAtr = entryContext?.entryATR ?? null;
  const currentAtr = atrPipsCurrent ?? null;
  const atrRatio = Number.isFinite(entryAtr) && entryAtr > 0 && Number.isFinite(currentAtr)
    ? currentAtr / entryAtr
    : null;

  const entryState   = entryContext?.entryMarketState ?? null;
  const currentState = marketStateNow?.marketState   ?? null;
  const wasActiveState = ['TRENDING', 'BREAKOUT'].includes(entryState);
  const isStillActive  = ['TRENDING', 'BREAKOUT'].includes(currentState);
  const stateContracted = wasActiveState && !isStillActive;

  // Candle-range compression — last 6 vs prior 12
  let rangeRatio = null;
  if (Array.isArray(m15Candles) && m15Candles.length >= 18) {
    const recent = m15Candles.slice(-6);
    const prior  = m15Candles.slice(-18, -6);
    const avgRng = (cs) => cs.reduce((s, c) => s + (c.high - c.low), 0) / cs.length;
    const r = avgRng(recent), p = avgRng(prior);
    if (p > 0) rangeRatio = r / p;
  }

  let severity = 'low';
  const reasons = [];
  if (atrRatio != null && atrRatio < 0.7) {
    reasons.push(`ATR ratio ${atrRatio.toFixed(2)} (entry ${entryAtr}p → current ${currentAtr}p)`);
    severity = atrRatio < 0.5 ? 'high' : 'medium';
  }
  if (stateContracted) {
    reasons.push(`market state shifted ${entryState}→${currentState}`);
    if (currentState === 'CHOPPY' && (tpProgress ?? 0) < 0.3) severity = 'high';
    else if (severity === 'low') severity = 'medium';
  }
  if (rangeRatio != null && rangeRatio < 0.6) {
    reasons.push(`M15 candle range compressed to ${(rangeRatio * 100).toFixed(0)}% of pre-entry`);
    if (severity === 'low') severity = 'medium';
  }

  const collapsed = severity !== 'low' && reasons.length > 0;
  return {
    volatilityCollapsed: collapsed,
    volatilityCollapseSeverity: collapsed ? severity : 'low',
    volatilityReason: collapsed
      ? `Volatility collapsed: ${reasons.join('; ')}`
      : `Volatility stable (ATR ratio ${atrRatio?.toFixed(2) ?? '—'}, state ${currentState})`,
    atrRatio,
    rangeRatio,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PART 7 — TREND WEAKENING
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Soft signals that the trend is losing steam, even before invalidation.
 *
 *  - EMA20 slope flattening from entry
 *  - No new H/L in trade direction over the last N bars
 *  - Lower-highs while long / higher-lows while short on M15
 *  - Candle bodies shrinking (last 5 avg body / prior 10 avg body < 0.7)
 *  - Wick fraction rising (≥ 0.5 in last 8 bars)
 *  - MTF alignment score dropped 10–19 (less than invalidation threshold)
 *  - marketStateScore declining vs entry
 */
export function detectTrendWeakening({
  side, m15Candles, mtfAuthorityNow, entryContext,
  marketStateNow,
}) {
  if (!Array.isArray(m15Candles) || m15Candles.length < 30) {
    return {
      trendWeakeningDetected: false,
      trendWeakeningSeverity: 'low',
      trendWeakeningReason: 'Insufficient candle data',
      signals: [],
    };
  }

  const signals = [];
  const closes = m15Candles.map(c => c.close);

  // EMA20 slope: now vs 10 bars ago
  const ema20Now = ema(closes, 20);
  const ema20Prev = ema(closes.slice(0, -10), 20);
  if (Number.isFinite(ema20Now) && Number.isFinite(ema20Prev)) {
    const slopeProTrade = side === 'long'
      ? (ema20Now - ema20Prev) > 0
      : (ema20Now - ema20Prev) < 0;
    if (!slopeProTrade) {
      signals.push(`M15 EMA20 slope is no longer in trade direction (${ema20Prev.toFixed(5)} → ${ema20Now.toFixed(5)})`);
    }
  }

  // New H/L count over the last 8 bars
  const last8 = m15Candles.slice(-8);
  if (side === 'long') {
    const hi = Math.max(...last8.map(c => c.high));
    const earlierHi = Math.max(...m15Candles.slice(-20, -8).map(c => c.high));
    if (hi <= earlierHi) signals.push('No new high in the last 8 M15 bars');
  } else {
    const lo = Math.min(...last8.map(c => c.low));
    const earlierLo = Math.min(...m15Candles.slice(-20, -8).map(c => c.low));
    if (lo >= earlierLo) signals.push('No new low in the last 8 M15 bars');
  }

  // Candle body shrinkage
  const avgBody = (cs) => cs.reduce((s, c) => s + Math.abs(c.close - c.open), 0) / cs.length;
  const recBody = avgBody(m15Candles.slice(-5));
  const priorBody = avgBody(m15Candles.slice(-15, -5));
  if (priorBody > 0 && recBody / priorBody < 0.7) {
    signals.push(`Candle bodies shrinking (${(recBody / priorBody * 100).toFixed(0)}% of prior 10-bar avg)`);
  }

  // Wick fraction
  const wickShare = (cs) => {
    let w = 0;
    for (const c of cs) {
      const body = Math.abs(c.close - c.open);
      const range = c.high - c.low;
      if (range > 0 && (range - body) / range > 0.6) w++;
    }
    return w / cs.length;
  };
  const wf = wickShare(m15Candles.slice(-8));
  if (wf >= 0.5) signals.push(`${(wf * 100).toFixed(0)}% of last 8 bars are wick-dominated`);

  // MTF alignment drop (less than 20 — that's invalidation territory)
  const mtfNow = mtfAuthorityNow?.multiTimeframeAlignmentScore ?? null;
  const mtfEntry = entryContext?.entryMtfAlignmentScore ?? null;
  if (mtfEntry != null && mtfNow != null) {
    const drop = mtfEntry - mtfNow;
    if (drop >= 10 && drop < 20) {
      signals.push(`MTF alignment slipped ${drop} pts since entry (${mtfEntry}→${mtfNow})`);
    }
  }

  // Market-state score declining
  const stateNow = marketStateNow?.marketStateScore ?? null;
  const stateEntry = entryContext?.entryMarketStateScore ?? null;
  if (stateEntry != null && stateNow != null && (stateEntry - stateNow) >= 10) {
    signals.push(`Market state score dropped ${stateEntry - stateNow} pts (${stateEntry}→${stateNow})`);
  }

  let severity = 'low';
  if (signals.length >= 4)      severity = 'high';
  else if (signals.length >= 2) severity = 'medium';

  return {
    trendWeakeningDetected: severity !== 'low',
    trendWeakeningSeverity: severity,
    trendWeakeningReason: signals.length
      ? `${signals.length} weakening signal${signals.length === 1 ? '' : 's'}: ${signals.join(' · ')}`
      : 'Trend stable',
    signals,
  };
}
