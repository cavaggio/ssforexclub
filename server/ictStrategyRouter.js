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
  const momentumAligned = h1Momentum?.activeAligned === true || h1Momentum?.aligned === true;
  const h1ActiveAligned = momentumAligned || transitionAligned;

  const directContinuationReady = Boolean(
    wanted &&
    htfAligned === true &&
    h1ActiveAligned &&
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
        strategy: continuationBreakout.mode === 'm5_continuation_retest'
          ? 'continuation_retest'
          : 'continuation_breakout',
        source: 'direct_continuation',
        requiresMarketMakerActive: false,
        reason:
          `D1/H4 direction, H1 active momentum/transition, and a fresh M5 ${continuationBreakout.mode === 'm5_continuation_retest' ? 'retest' : 'breakout'} ` +
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

  const continuationReason = directContinuationReady
    ? directContinuation.reason
    : continuationBreakout?.reason ||
      (h1ActiveAligned
        ? 'No fresh M5 continuation breakout/retest is ready.'
        : h1Momentum?.reason || 'H1 active momentum/transition is not aligned.');
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
    candidates: {
      continuation: {
        ready: directContinuationReady,
        reason: continuationReason,
        mode: continuationBreakout?.mode || null,
        cycleId: continuationBreakout?.cycleId || null,
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
