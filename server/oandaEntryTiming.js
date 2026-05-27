/**
 * server/oandaEntryTiming.js
 *
 * Entry-timing classifier. Folds Fibonacci retracement, institutional-flow
 * proxies, structure analysis, and news risk into a single status that gates
 * execution.
 *
 *   classifyEntryTiming({...}) → {
 *     status: 'valid_entry' | 'too_early' | 'late_entry' | 'wait_for_retest' | 'news_blocked',
 *     reason: string,
 *     suggestedEntryZone: { lower: number, upper: number } | null,
 *     invalidationLevel: number | null,
 *     confirmationNeeded: string | null,
 *     factors: { fib, flow, news, structure },  // raw inputs preserved for audit
 *   }
 *
 * Decision order:
 *   1. news.blocked              → news_blocked
 *   2. flow.direction opposes    → late_entry (or block, caller decides)
 *   3. fib === 'extended'/'invalidated' → late_entry
 *   4. fib === 'too_early'       → too_early   (suggested zone returned)
 *   5. fib === 'breakout_confirmed' + no retest → wait_for_retest
 *   6. structure.consolidation + no flow.range_breakout/retest → wait_for_retest
 *   7. otherwise                  → valid_entry
 */

export function classifyEntryTiming({
  direction,
  fibonacci,         // output of detectFibSetup
  institutionalFlow, // output of analyzeInstitutionalFlow
  structure,         // output of analyzeStructure (h1/m30 layer)
  momentum,          // output of analyzeMomentum
  newsRisk,          // output of getForexNewsRisk
  currentPrice,
  pair,
}) {
  const factors = {
    fib: fibonacci?.entryZoneStatus || 'unknown',
    flow: institutionalFlow?.direction || 'neutral',
    flowType: institutionalFlow?.type || 'none',
    news: newsRisk?.riskLevel || 'low',
    structureType: structure?.nearKeyLevel?.kind || null,
    reversalRisk: structure?.reversalRisk || 'low',
    postNewsConfirm: newsRisk?.postNewsConfirmationRequired === true,
  };

  const suggestedEntryZone = fibonacci?.entryZone || null;
  const tradeSign = direction === 'long' ? 'bullish' : direction === 'short' ? 'bearish' : null;

  // ── Rule 1: News block ────────────────────────────────────────────────────
  if (newsRisk?.blocked === true) {
    return {
      status: 'news_blocked',
      reason: newsRisk.reason || 'High-impact news in risk window',
      suggestedEntryZone,
      invalidationLevel: null,
      confirmationNeeded: 'Wait for news event to print and re-evaluate after volatility settles',
      factors,
    };
  }

  // ── Rule 2: Order-flow opposes trade direction ────────────────────────────
  if (
    tradeSign &&
    institutionalFlow?.direction &&
    institutionalFlow.direction !== 'neutral' &&
    institutionalFlow.direction !== tradeSign
  ) {
    return {
      status: 'late_entry',
      reason:
        `Institutional flow proxy (${institutionalFlow.type}) points ${institutionalFlow.direction} ` +
        `while trade direction is ${direction} — order flow opposes setup`,
      suggestedEntryZone,
      invalidationLevel: null,
      confirmationNeeded:
        'Wait for flow to align (BOS / CHoCH / liquidity sweep in trade direction)',
      factors,
    };
  }

  // ── Rule 3: Fibonacci says price is past the impulse target / origin ──────
  if (fibonacci?.entryZoneStatus === 'extended') {
    return {
      status: 'late_entry',
      reason:
        fibonacci.reason ||
        `Price extended beyond impulse target on ${fibonacci.timeframeUsed} — chasing risk`,
      suggestedEntryZone,
      invalidationLevel: direction === 'long' ? fibonacci.swingLow : fibonacci.swingHigh,
      confirmationNeeded:
        'Wait for retracement back into the Fibonacci entry zone (38.2–78.6%) or a clear retest after a breakout',
      factors,
    };
  }
  if (fibonacci?.entryZoneStatus === 'invalidated') {
    return {
      status: 'late_entry',
      reason: fibonacci.reason || 'Impulse origin invalidated — setup no longer valid',
      suggestedEntryZone: null,
      invalidationLevel: null,
      confirmationNeeded: 'Wait for a fresh impulse leg to form on H1/H4',
      factors,
    };
  }

  // ── Rule 4: Fibonacci says price has not retraced yet ─────────────────────
  if (fibonacci?.entryZoneStatus === 'too_early') {
    return {
      status: 'too_early',
      reason: fibonacci.reason || 'Price has not retraced into the Fibonacci entry zone yet',
      suggestedEntryZone,
      invalidationLevel: direction === 'long' ? fibonacci.swingLow : fibonacci.swingHigh,
      confirmationNeeded:
        `Wait for ${direction === 'long' ? 'pullback down' : 'pullback up'} into ${
          suggestedEntryZone
            ? `${suggestedEntryZone.lower}–${suggestedEntryZone.upper}`
            : 'a 38.2–78.6% retracement'
        }`,
      factors,
    };
  }

  // ── Rule 5: Breakout confirmed but no retest ──────────────────────────────
  if (fibonacci?.entryZoneStatus === 'breakout_confirmed') {
    const hasRetest = (institutionalFlow?.signals || []).some(s => s.type === 'retest');
    if (!hasRetest) {
      return {
        status: 'wait_for_retest',
        reason:
          (fibonacci.reason || 'Breakout confirmed') +
          ' — but no retest of the broken level has formed yet',
        suggestedEntryZone:
          direction === 'long'
            ? { lower: fibonacci.swingHigh, upper: fibonacci.swingHigh }
            : { lower: fibonacci.swingLow,  upper: fibonacci.swingLow  },
        invalidationLevel: direction === 'long' ? fibonacci.swingLow : fibonacci.swingHigh,
        confirmationNeeded:
          'Wait for price to retest the broken impulse level and hold (within ~0.3×ATR)',
        factors,
      };
    }
  }

  // ── Rule 6: Macro structure is consolidating, no breakout/retest fired ────
  const consolidating =
    structure?.nearKeyLevel === null &&
    fibonacci?.entryZoneStatus === 'unknown' &&
    !(institutionalFlow?.signals || []).some(s =>
      s.type === 'range_breakout' || s.type === 'retest' || s.type === 'break_of_structure'
    );
  if (consolidating && momentum?.executionConfirmation !== 'full') {
    return {
      status: 'wait_for_retest',
      reason:
        'Macro / structure is consolidating and no range-breakout, retest, or BOS has fired ' +
        '— directional commitment unclear',
      suggestedEntryZone,
      invalidationLevel: null,
      confirmationNeeded:
        'Wait for a clean range breakout WITH retest, or a higher-timeframe BOS in the trade direction',
      factors,
    };
  }

  // ── Rule 7: Post-news confirmation pending ────────────────────────────────
  if (newsRisk?.postNewsConfirmationRequired) {
    const flowConfirms =
      tradeSign &&
      institutionalFlow?.direction === tradeSign &&
      institutionalFlow?.confidenceImpact >= 15;
    if (!flowConfirms) {
      return {
        status: 'wait_for_retest',
        reason:
          (newsRisk.reason || 'Recent high-impact news event') +
          ' — institutional flow has not confirmed the trade direction post-news',
        suggestedEntryZone,
        invalidationLevel: null,
        confirmationNeeded: 'Wait for BOS / liquidity sweep / retest in trade direction',
        factors,
      };
    }
  }

  // ── Default: valid entry ──────────────────────────────────────────────────
  return {
    status: 'valid_entry',
    reason:
      `Entry timing valid: fib=${fibonacci?.entryZoneStatus ?? 'unknown'}, ` +
      `flow=${institutionalFlow?.direction ?? 'neutral'} (${institutionalFlow?.type ?? 'none'}), ` +
      `news=${newsRisk?.riskLevel ?? 'low'}`,
    suggestedEntryZone,
    invalidationLevel: direction === 'long' ? fibonacci?.swingLow ?? null : fibonacci?.swingHigh ?? null,
    confirmationNeeded: null,
    factors,
  };
}
