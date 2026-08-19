/**
 * Independent ICT strategy router.
 *
 * This is intentionally an OR-router, not a confirmation stack. A continuation
 * breakout and a reversal are different models with different required evidence.
 * The persistent PO3/market-maker cycle remains authoritative for reversal
 * activation, but it is not a universal prerequisite for a valid continuation.
 */

const normalizeDirection = (value) => {
  const direction = String(value || '').toLowerCase();
  if (['bullish', 'buy', 'long'].includes(direction)) return 'bullish';
  if (['bearish', 'sell', 'short'].includes(direction)) return 'bearish';
  return null;
};

function isInitialReversal(mode) {
  return String(mode || '').toLowerCase().startsWith('initial_reversal_');
}

function isContinuation(mode) {
  const value = String(mode || '').toLowerCase();
  return value === 'h1_transition' || value.startsWith('m5_continuation_');
}

function continuationStrategy(mode) {
  const value = String(mode || '').toLowerCase();
  if (value === 'm5_continuation_recovery') return 'continuation_recovery';
  if (value === 'm5_continuation_retest') return 'continuation_retest';
  return 'continuation_breakout';
}

function earlySessionLabel(profile) {
  if (!profile || profile.availableCount < 1) return '01:00-03:00 ET context unavailable';
  return `01:00-03:00 ET context ${profile.direction}${profile.provisional ? ' (provisional)' : ''}`;
}

export function resolveIctStrategyAuthorization({
  direction,
  htfAligned = false,
  h1Momentum = null,
  h1Transition = null,
  continuationBreakout = null,
  marketMakerResolution = null,
  earlySessionDirection = null,
} = {}) {
  const wanted = normalizeDirection(direction);
  const marketMakerAuthorization = marketMakerResolution?.entryAuthorization || {};
  const transitionAligned = h1Transition?.ready === true && normalizeDirection(h1Transition?.bias) === wanted;
  const momentumAligned = h1Momentum?.currentAligned === true ||
    h1Momentum?.activeAligned === true || h1Momentum?.aligned === true;
  const earlySessionAligned = earlySessionDirection?.alignedWithBias === true &&
    Number(earlySessionDirection?.completedCount || 0) >= 2;
  const currentH1Opposing = h1Momentum?.currentOpposing === true;
  const h1ContextAligned = !currentH1Opposing &&
    (momentumAligned || transitionAligned || earlySessionAligned);

  const directContinuationReady = Boolean(
    wanted &&
    htfAligned === true &&
    h1ContextAligned &&
    continuationBreakout?.ready === true &&
    continuationBreakout?.cycleId,
  );

  const directContinuation = directContinuationReady
    ? {
        ready: true,
        mode: continuationBreakout.mode || 'm5_continuation_breakout',
        cycleId: `direct:${continuationBreakout.cycleId}`,
        parentCycleId: null,
        family: 'continuation',
        strategy: continuationStrategy(continuationBreakout.mode),
        source: 'direct_continuation',
        requiresMarketMakerActive: false,
        reason:
          `D1/H4 direction plus aligned H1/current-session context and a fresh M5 ${continuationStrategy(continuationBreakout.mode).replace('continuation_', '')} ` +
          `authorize continuation independently of the PO3 reversal cycle; ${earlySessionLabel(earlySessionDirection)}.`,
      }
    : null;

  const marketMakerReady = marketMakerAuthorization?.ready === true && Boolean(marketMakerAuthorization?.cycleId);
  const marketMakerCandidate = marketMakerReady
    ? {
        ...marketMakerAuthorization,
        family: isInitialReversal(marketMakerAuthorization.mode)
          ? 'reversal'
          : isContinuation(marketMakerAuthorization.mode) ? 'continuation' : null,
        strategy: isInitialReversal(marketMakerAuthorization.mode)
          ? 'reversal'
          : 'market_maker_continuation',
        source: 'market_maker',
        requiresMarketMakerActive: true,
      }
    : null;

  // If the complete reversal sequence fired on this scan, preserve that model as
  // the selected explanation. Otherwise a valid direct continuation is allowed
  // to stand on its own rather than waiting for DISTRIBUTION_ACTIVE.
  const selected = marketMakerCandidate && isInitialReversal(marketMakerCandidate.mode)
    ? marketMakerCandidate
    : directContinuation || marketMakerCandidate;

  const h1FailureReason = currentH1Opposing
    ? (h1Momentum?.reason || 'The live H1 candle is actively opposing D1/H4.')
    : h1Momentum?.exhausted === true
      ? (h1Momentum?.reason || 'H1 active momentum is exhausted.')
      : (h1Momentum?.reason || h1Transition?.reason || 'H1/current-session continuation context is not aligned.');
  const continuationReason = directContinuationReady
    ? directContinuation.reason
    : !h1ContextAligned
      ? h1FailureReason
      : continuationBreakout?.reason || 'No fresh M5 continuation breakout/recovery is ready.';
  const reversalReason = marketMakerAuthorization?.reason || 'The reversal/PO3 model is not authorized.';

  const entryAuthorization = selected || {
    ready: false,
    mode: 'none',
    cycleId: null,
    parentCycleId: null,
    family: null,
    strategy: null,
    source: 'strategy_router',
    requiresMarketMakerActive: false,
    reason: `No ICT strategy authorized. Continuation: ${continuationReason} Reversal/PO3: ${reversalReason}`,
  };

  return {
    entryAuthorization,
    selectedStrategy: entryAuthorization.strategy,
    selectedFamily: entryAuthorization.family,
    selectedSource: entryAuthorization.source,
    earlySessionDirection,
    h1Context: {
      momentumAligned,
      transitionAligned,
      earlySessionAligned,
      currentH1Opposing,
      aligned: h1ContextAligned,
    },
    candidates: {
      continuation: {
        ready: directContinuationReady,
        reason: continuationReason,
        mode: continuationBreakout?.mode || null,
        cycleId: continuationBreakout?.cycleId || null,
        recoveryArmed: continuationBreakout?.recoveryArmed === true,
        triggerAgeMinutes: continuationBreakout?.triggerAgeMinutes ?? null,
      },
      reversal: {
        ready: Boolean(marketMakerCandidate && isInitialReversal(marketMakerCandidate.mode)),
        reason: reversalReason,
        mode: marketMakerCandidate?.mode || null,
        cycleId: marketMakerCandidate?.cycleId || null,
      },
      marketMakerContinuation: {
        ready: Boolean(marketMakerCandidate && !isInitialReversal(marketMakerCandidate.mode)),
        reason: marketMakerCandidate?.reason || reversalReason,
        mode: marketMakerCandidate?.mode || null,
        cycleId: marketMakerCandidate?.cycleId || null,
      },
    },
    rule: 'authorize_any_complete_strategy_model_not_all_models',
  };
}
