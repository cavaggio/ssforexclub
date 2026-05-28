/**
 * server/oandaTradeManagement.js
 *
 * EXIT-SIDE management for active trades. Generates trailing-stop,
 * partial-exit, dynamic-TP-reduction and profit-protection recommendations
 * from the current waterfall + entry context.
 *
 *   computeTrailingStop(ctx)          → Part 2
 *   computePartialExit(ctx)           → Part 3
 *   computeTpReduction(ctx)           → Part 5
 *   computeProfitProtection(ctx)      → Part 8
 *
 * ALL functions are pure — given the same inputs they produce the same
 * recommendation. Side-effects (broker calls, history writes) live in the
 * orchestrator. Each function returns the spec'd fields plus a `recommended`
 * boolean so the orchestrator can decide priority order.
 */

import { atr } from './oandaIndicators.js';

const PIP_SIZE = {
  XAU_USD: 0.01, XAG_USD: 0.01,
  // Indices: pip = 1.0 — index ATR units are already "pips".
};

function getPipSize(pair) {
  if (pair && PIP_SIZE[pair]) return PIP_SIZE[pair];
  if (pair && /^(NAS100|US30|SPX500|DE30|UK100)/.test(pair)) return 1.0;
  if (pair && pair.includes('JPY')) return 0.01;
  return 0.0001;
}

function pricePrecision(pair) {
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return 2;
  if (pair && /^(NAS100|US30|SPX500|DE30|UK100)/.test(pair)) return 1;
  if (pair && pair.includes('JPY')) return 3;
  return 5;
}

/**
 * R-multiple — how many "R" (units of original risk) of profit the trade has
 * captured. R = |entry - originalSL| in pips. ProfitR = profitPips / R.
 */
function computeRMultiple({ side, entryPrice, currentPrice, originalSL, pipSize }) {
  if (!Number.isFinite(originalSL) || !Number.isFinite(entryPrice) || !Number.isFinite(currentPrice)) {
    return { R: null, profitPips: null, profitR: null };
  }
  const rPrice = Math.abs(entryPrice - originalSL);
  const rPips = rPrice / pipSize;
  if (rPips <= 0) return { R: null, profitPips: null, profitR: null };
  const profitPips = side === 'long'
    ? (currentPrice - entryPrice) / pipSize
    : (entryPrice - currentPrice) / pipSize;
  return {
    R: +rPips.toFixed(2),
    profitPips: +profitPips.toFixed(2),
    profitR: +(profitPips / rPips).toFixed(2),
  };
}

/**
 * Find a recent M15 swing low (for longs) or swing high (for shorts) that
 * can host a trailing stop. We look back ~10 bars; structure-aware trailing.
 */
function findTrailingAnchor({ side, m15Candles }) {
  if (!Array.isArray(m15Candles) || m15Candles.length < 6) return null;
  const slice = m15Candles.slice(-10);
  if (side === 'long')  return Math.min(...slice.map(c => c.low));
  return Math.max(...slice.map(c => c.high));
}

// ═══════════════════════════════════════════════════════════════════════════════
// PART 2 — TRAILING STOP
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Asset-class-aware trailing logic.
 *
 *   Forex:   activate after 0.75–1.0 ATR profit
 *   Metals:  activate after 1.0–1.5 ATR profit
 *   Indices: activate after 1.0 ATR profit OR confirmed breakout retest
 *
 *   profitR ≥ 1   → move SL to breakeven (or +0.1R) for ALL classes
 *   profitR ≥ 1.5 → trail behind recent M15 swing + ATR buffer
 *   profitR ≥ 2   → tighter ATR trail, protect 50–70% of open profit
 *
 *   In CHOPPY / RANGING / volatility-collapsed conditions: tighten trail.
 *
 * Returns:
 *   { trailingStopRecommended, recommendedStopLoss, trailingReason }
 */
export function computeTrailingStop({
  side, entryPrice, currentPrice, originalSL, currentSL,
  pair, assetClass, marketState, m15Candles, atrPipsCurrent,
  institutionalFlow,
}) {
  const pipSize = getPipSize(pair);
  const { R, profitR } = computeRMultiple({ side, entryPrice, currentPrice, originalSL, pipSize });
  if (R === null || profitR === null) {
    return { trailingStopRecommended: false, recommendedStopLoss: null, trailingReason: 'Insufficient data — no original SL or current price' };
  }

  // Asset-class profit activation thresholds (in ATR units)
  const atrTriggerByClass = assetClass === 'Metal' ? 1.0
    : assetClass === 'Index' ? 1.0
    : 0.75;
  const atrPips = atrPipsCurrent || 0;
  const profitPips = profitR * R;
  const profitAtrUnits = atrPips > 0 ? profitPips / atrPips : 0;

  // Indices: also acceptable to activate on confirmed breakout retest
  const indexRetestConfirmed =
    assetClass === 'Index' &&
    (institutionalFlow?.signals || []).some(
      s => s.type === 'retest' &&
        s.direction === (side === 'long' ? 'bullish' : 'bearish')
    );

  if (profitR < 1 && profitAtrUnits < atrTriggerByClass && !indexRetestConfirmed) {
    return {
      trailingStopRecommended: false,
      recommendedStopLoss: null,
      trailingReason: `Trade has not yet reached profit threshold (profitR=${profitR}, ATR units=${profitAtrUnits.toFixed(2)}, ${assetClass} requires ≥ ${atrTriggerByClass} ATR or 1R)`,
    };
  }

  // ── Tier 1: breakeven move ────────────────────────────────────────────────
  let level;
  let reason;
  if (profitR < 1.5) {
    const buffer = atrPips * 0.1 * pipSize;
    level = side === 'long' ? entryPrice + buffer : entryPrice - buffer;
    reason = `Move SL to breakeven after +${profitR}R (asset class ${assetClass})`;
  }
  // ── Tier 2: trail behind structure ────────────────────────────────────────
  else if (profitR < 2) {
    const anchor = findTrailingAnchor({ side, m15Candles });
    const buf = Math.max(atrPips * 0.3, 5) * pipSize;
    if (anchor != null) {
      level = side === 'long' ? anchor - buf : anchor + buf;
      reason = `Trail behind M15 swing ${side === 'long' ? 'low' : 'high'} ${anchor.toFixed(pricePrecision(pair))} − ${(buf / pipSize).toFixed(1)}p ATR buffer (+${profitR}R)`;
    } else {
      // Fallback to ATR-based trail
      const trail = atrPips * 1.0 * pipSize;
      level = side === 'long' ? currentPrice - trail : currentPrice + trail;
      reason = `ATR-based trail (1.0×ATR ${atrPips}p) — no clean swing anchor found`;
    }
  }
  // ── Tier 3: tighter trail, protect majority of open profit ────────────────
  else {
    const protectFraction = 0.6;            // protect 60% of open profit
    const protectPips = profitPips * protectFraction;
    const protectPrice = side === 'long'
      ? entryPrice + protectPips * pipSize
      : entryPrice - protectPips * pipSize;
    // But never beyond a 0.6×ATR distance from current price (don't squeeze too tight)
    const minDist = atrPips * 0.6 * pipSize;
    const atrCap = side === 'long' ? currentPrice - minDist : currentPrice + minDist;
    level = side === 'long' ? Math.max(protectPrice, atrCap) : Math.min(protectPrice, atrCap);
    reason = `Protect ${(protectFraction * 100).toFixed(0)}% of open profit (+${profitR}R, ATR floor 0.6×ATR = ${atrPips}p)`;
  }

  // Choppy / volatility-collapsed regimes: tighten further (pull SL closer to price)
  if (marketState?.marketState === 'CHOPPY' ||
      marketState?.marketState === 'RANGING' ||
      marketState?.marketState === 'LOW_LIQUIDITY') {
    const tightenedDist = atrPips * 0.5 * pipSize;
    const tightenedLevel = side === 'long'
      ? currentPrice - tightenedDist
      : currentPrice + tightenedDist;
    // Only tighten if it actually moves the stop closer to price (better protection)
    if ((side === 'long' && tightenedLevel > level) ||
        (side === 'short' && tightenedLevel < level)) {
      level = tightenedLevel;
      reason += ` · tightened to 0.5×ATR (market state ${marketState.marketState})`;
    }
  }

  // Don't move the SL backwards (worse than current). If we'd loosen, skip.
  if (Number.isFinite(currentSL)) {
    if (side === 'long' && level < currentSL) {
      return {
        trailingStopRecommended: false,
        recommendedStopLoss: null,
        trailingReason: `Computed trail ${level.toFixed(pricePrecision(pair))} is worse than current SL ${currentSL.toFixed(pricePrecision(pair))} — skip`,
      };
    }
    if (side === 'short' && level > currentSL) {
      return {
        trailingStopRecommended: false,
        recommendedStopLoss: null,
        trailingReason: `Computed trail ${level.toFixed(pricePrecision(pair))} is worse than current SL ${currentSL.toFixed(pricePrecision(pair))} — skip`,
      };
    }
  }

  return {
    trailingStopRecommended: true,
    recommendedStopLoss: +level.toFixed(pricePrecision(pair)),
    trailingReason: reason,
    profitR,
    profitAtrUnits: +profitAtrUnits.toFixed(2),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PART 3 — PARTIAL EXIT
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Partial-exit logic. Conservative — only fires when profit is meaningful AND
 * the thesis is weakening (or trade is approaching but not reaching TP).
 *
 *   +1R   + state weakened           → 25%
 *   +1.5R + trend/volatility weak    → 25–50%
 *   +2R   + reversal-risk            → 50%
 *   ≥70% of TP + momentum weakening  → 25–50%
 */
export function computePartialExit({
  side, entryPrice, currentPrice, originalSL, originalTP,
  pair, marketState, structure, momentum, mtfAuthorityNow, mtfAuthorityAtEntry,
}) {
  const pipSize = getPipSize(pair);
  const { profitR } = computeRMultiple({ side, entryPrice, currentPrice, originalSL, pipSize });
  if (profitR == null || profitR <= 0) {
    return { partialExitRecommended: false, partialExitPercent: 0, partialExitReason: 'Trade not in profit' };
  }

  // TP-progress fraction
  const tpDist = Number.isFinite(originalTP)
    ? Math.abs(originalTP - entryPrice) / pipSize
    : 0;
  const progressPips = profitR * (Math.abs(entryPrice - originalSL) / pipSize);
  const tpProgress = tpDist > 0 ? progressPips / tpDist : 0;

  // Weakening signals
  const stateWeak =
    marketState?.marketState === 'CHOPPY' ||
    marketState?.marketState === 'RANGING' ||
    marketState?.marketState === 'LOW_LIQUIDITY' ||
    marketState?.marketState === 'REVERSAL_RISK';
  const reversalRiskHigh = structure?.reversalRisk === 'high';
  const momentumWeak = (momentum?.momentumStrength ?? 100) < 35;
  const mtfDrop = mtfAuthorityAtEntry?.multiTimeframeAlignmentScore && mtfAuthorityNow?.multiTimeframeAlignmentScore
    ? (mtfAuthorityAtEntry.multiTimeframeAlignmentScore - mtfAuthorityNow.multiTimeframeAlignmentScore) >= 15
    : false;

  // Decision tree
  let pct = 0;
  let why = null;
  if (profitR >= 2 && (reversalRiskHigh || mtfDrop || stateWeak)) {
    pct = 50;
    why = `+${profitR}R reached and ${reversalRiskHigh ? 'structure reversal risk HIGH' : stateWeak ? `market state ${marketState.marketState}` : 'MTF alignment dropped ≥15 pts'}`;
  } else if (profitR >= 1.5 && (stateWeak || momentumWeak || mtfDrop)) {
    pct = 33;
    why = `+${profitR}R reached and ${stateWeak ? `state ${marketState.marketState}` : momentumWeak ? `momentum weak (${momentum?.momentumStrength ?? '—'})` : 'MTF dropped ≥15'}`;
  } else if (profitR >= 1.0 && stateWeak) {
    pct = 25;
    why = `+${profitR}R reached and market state weakened to ${marketState.marketState}`;
  } else if (tpProgress >= 0.7 && momentumWeak) {
    pct = 33;
    why = `Trade has covered ${(tpProgress * 100).toFixed(0)}% of TP but momentum is weakening — lock in partial`;
  }

  if (pct === 0) {
    return {
      partialExitRecommended: false,
      partialExitPercent: 0,
      partialExitReason: `No partial-exit trigger (profitR=${profitR}, tpProgress=${(tpProgress * 100).toFixed(0)}%, state=${marketState?.marketState ?? '—'})`,
    };
  }

  return {
    partialExitRecommended: true,
    partialExitPercent: pct,
    partialExitReason: `Partial ${pct}% recommended: ${why}`,
    tpProgress: +tpProgress.toFixed(2),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PART 5 — DYNAMIC TP REDUCTION
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Reduce TP when:
 *  - ATR contracted significantly since entry (TP would now require unrealistic move)
 *  - Market state shifted from TRENDING/BREAKOUT to CHOPPY/RANGING/LOW_LIQUIDITY
 *  - Price approached but did not reach TP, momentum weakened
 *  - A key level is between current price and original TP (blocker emerged)
 *
 * The reduced TP is conservative: pulled in to the nearest of:
 *   - 1.5× current-ATR from current price
 *   - 4p before the nearest blocking unbroken H4 level
 *   - somewhere between the current price and the original TP, capped to 0.5R
 */
export function computeTpReduction({
  side, entryPrice, currentPrice, originalSL, originalTP,
  pair, marketState, macro, atrPipsAtEntry, atrPipsCurrent, momentum,
}) {
  if (!Number.isFinite(originalTP) || !Number.isFinite(currentPrice)) {
    return { tpReductionRecommended: false, recommendedTakeProfit: null, tpReductionReason: 'No original TP set' };
  }
  const pipSize = getPipSize(pair);

  const distToTpPips = side === 'long'
    ? (originalTP - currentPrice) / pipSize
    : (currentPrice - originalTP) / pipSize;

  if (distToTpPips <= 0) {
    return { tpReductionRecommended: false, recommendedTakeProfit: null, tpReductionReason: 'Already at or past TP' };
  }

  const atrCurr = atrPipsCurrent || 0;
  const atrEntry = atrPipsAtEntry || atrCurr;
  const atrRatio = atrEntry > 0 ? atrCurr / atrEntry : 1;

  const stateContracted = ['CHOPPY', 'RANGING', 'LOW_LIQUIDITY'].includes(marketState?.marketState);
  const atrCollapsed = atrRatio < 0.7;
  const momentumWeak = (momentum?.momentumStrength ?? 100) < 35;
  const tpRequiresMoreThan3Atr = atrCurr > 0 && (distToTpPips / atrCurr) > 3;

  if (!stateContracted && !atrCollapsed && !tpRequiresMoreThan3Atr) {
    return {
      tpReductionRecommended: false,
      recommendedTakeProfit: null,
      tpReductionReason: `Original TP still realistic (state=${marketState?.marketState}, ATR ratio ${atrRatio.toFixed(2)}, ${atrCurr > 0 ? (distToTpPips / atrCurr).toFixed(2) : '—'}× current ATR remaining)`,
    };
  }

  // Compute reduced TP
  const cappedByAtr = currentPrice + (side === 'long' ? 1 : -1) * atrCurr * 1.5 * pipSize;
  // Key-level cap from macro.keyLevels in the trade direction
  let keyLevelCap = null;
  const keyLevels = macro?.keyLevels || [];
  const blockers = keyLevels.filter(lvl =>
    side === 'long'
      ? lvl.kind === 'resistance' && lvl.price > currentPrice && lvl.price < originalTP
      : lvl.kind === 'support'    && lvl.price < currentPrice && lvl.price > originalTP
  );
  if (blockers.length) {
    const nearest = side === 'long'
      ? blockers.reduce((a, b) => a.price < b.price ? a : b)
      : blockers.reduce((a, b) => a.price > b.price ? a : b);
    keyLevelCap = side === 'long'
      ? nearest.price - 4 * pipSize
      : nearest.price + 4 * pipSize;
  }

  // Pick the closer of the caps (i.e. the more conservative TP)
  let reduced;
  if (Number.isFinite(keyLevelCap)) {
    reduced = side === 'long' ? Math.min(cappedByAtr, keyLevelCap) : Math.max(cappedByAtr, keyLevelCap);
  } else {
    reduced = cappedByAtr;
  }
  // Don't go BELOW current price (long) or above (short) — that would be an exit, not a TP reduction
  if (side === 'long' && reduced <= currentPrice) reduced = currentPrice + atrCurr * 0.3 * pipSize;
  if (side === 'short' && reduced >= currentPrice) reduced = currentPrice - atrCurr * 0.3 * pipSize;

  const reasonParts = [];
  if (atrCollapsed) reasonParts.push(`ATR collapsed to ${(atrRatio * 100).toFixed(0)}% of entry`);
  if (stateContracted) reasonParts.push(`market state ${marketState.marketState}`);
  if (tpRequiresMoreThan3Atr) reasonParts.push(`original TP ${(distToTpPips / atrCurr).toFixed(1)}× current ATR away`);
  if (momentumWeak) reasonParts.push(`momentum weak (${momentum?.momentumStrength ?? '—'})`);
  if (Number.isFinite(keyLevelCap)) reasonParts.push(`H4 key level at ${blockers[0].price}`);

  return {
    tpReductionRecommended: true,
    recommendedTakeProfit: +reduced.toFixed(pricePrecision(pair)),
    tpReductionReason: `TP reduced due to volatility collapse / unrealistic remaining distance: ${reasonParts.join('; ')}`,
    atrRatio: +atrRatio.toFixed(2),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PART 8 — PROFIT PROTECTION (MFE / giveback)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Triggered when the trade has captured meaningful profit but is now giving
 * it back. Combined with MFE (max favorable excursion) tracked by the
 * orchestrator from the history records.
 *
 *   profitR ≥ 1                            → level 1 (move-to-BE)
 *   profitR ≥ 1.5                          → level 2 (lock-meaningful)
 *   profitR ≥ 2                            → level 3 (protect-majority)
 *   tpProgress ≥ 0.7  + momentum weak      → level 2 + partial recommended
 *   giveback ≥ 50% of MFE                  → level 4 (EXIT_REVIEW / PROTECT)
 */
export function computeProfitProtection({
  side, entryPrice, currentPrice, originalSL, originalTP,
  pair, maxFavorableExcursionPips, momentum,
}) {
  const pipSize = getPipSize(pair);
  const { profitR } = computeRMultiple({ side, entryPrice, currentPrice, originalSL, pipSize });
  if (profitR == null || profitR <= 0) {
    return {
      profitProtectionTriggered: false,
      profitProtectionLevel: 0,
      maxFavorableExcursion: maxFavorableExcursionPips ?? 0,
      givebackPercent: 0,
      profitProtectionReason: 'Trade not in profit',
    };
  }

  const profitPips = profitR * (Math.abs(entryPrice - originalSL) / pipSize);

  // MFE / giveback
  let givebackPct = 0;
  if (Number.isFinite(maxFavorableExcursionPips) && maxFavorableExcursionPips > 0) {
    const mfe = maxFavorableExcursionPips;
    givebackPct = mfe > 0 ? ((mfe - Math.max(profitPips, 0)) / mfe) * 100 : 0;
    givebackPct = Math.max(0, Math.min(100, givebackPct));
  }

  // Level computation
  let level = 0;
  let why = '';
  if (givebackPct >= 50 && (maxFavorableExcursionPips || 0) > 0) {
    level = 4;
    why = `Protect profit after major MFE giveback (${givebackPct.toFixed(0)}% of ${maxFavorableExcursionPips}p MFE returned)`;
  } else if (profitR >= 2) {
    level = 3;
    why = `+${profitR}R reached — protect majority of unrealized profit`;
  } else if (profitR >= 1.5) {
    level = 2;
    why = `+${profitR}R reached — lock meaningful profit`;
  } else if (profitR >= 1) {
    level = 1;
    why = `+${profitR}R reached — move SL to breakeven`;
  } else {
    return {
      profitProtectionTriggered: false,
      profitProtectionLevel: 0,
      maxFavorableExcursion: maxFavorableExcursionPips ?? 0,
      givebackPercent: +givebackPct.toFixed(1),
      profitProtectionReason: 'Below +1R — no protection trigger',
    };
  }

  return {
    profitProtectionTriggered: true,
    profitProtectionLevel: level,
    maxFavorableExcursion: +(maxFavorableExcursionPips ?? profitPips).toFixed(1),
    givebackPercent: +givebackPct.toFixed(1),
    profitProtectionReason: why,
    profitR,
  };
}

// Silence unused-import for `atr` — kept in case future expansion needs it
void atr;
