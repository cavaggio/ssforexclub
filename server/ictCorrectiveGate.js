const normalizeDirection = (value) => {
  const direction = String(value || '').toLowerCase();
  if (['bullish', 'buy', 'long'].includes(direction)) return 'bullish';
  if (['bearish', 'sell', 'short'].includes(direction)) return 'bearish';
  return null;
};

export const ICT_FAILURE_CODES = Object.freeze({
  HTF_DIRECTION_NOT_ALIGNED: 'HTF_DIRECTION_NOT_ALIGNED',
  H1_ACTIVE_MOMENTUM_NOT_ALIGNED: 'H1_ACTIVE_MOMENTUM_NOT_ALIGNED',
  H1_MOMENTUM_EXHAUSTED: 'H1_MOMENTUM_EXHAUSTED',
  STALE_M5_TRIGGER: 'STALE_M5_TRIGGER',
  MISSING_M5_AUTHORIZATION: 'MISSING_M5_AUTHORIZATION',
  HTF_LEVEL_NOT_TAPPED: 'HTF_LEVEL_NOT_TAPPED',
  LIQUIDITY_SWEEP_MISSING: 'LIQUIDITY_SWEEP_MISSING',
  OPPOSING_DISPLACEMENT_MISSING: 'OPPOSING_DISPLACEMENT_MISSING',
  CISD_MSS_MISSING: 'CISD_MSS_MISSING',
  UNKNOWN_ENTRY_FAMILY: 'UNKNOWN_ENTRY_FAMILY',
});

export function ictEntryFamily(mode) {
  const value = String(mode || '').toLowerCase();
  if (value.startsWith('initial_reversal_')) return 'reversal';
  if (value === 'h1_transition' || value.startsWith('m5_continuation_')) return 'continuation';
  return null;
}

export function evaluateIctCorrectiveGate({
  direction,
  timeframeBias = {},
  h1Momentum = null,
  h1Transition = null,
  entryAuthorization = null,
  triggerAgeBars = null,
  freshImpulse = false,
  marketMakerModel = null,
  concepts = null,
} = {}) {
  const wanted = normalizeDirection(direction || timeframeBias?.direction);
  const d1 = normalizeDirection(timeframeBias?.d1);
  const h4 = normalizeDirection(timeframeBias?.h4);
  const authorization = entryAuthorization || marketMakerModel?.entryAuthorization || {};
  const family = ictEntryFamily(authorization?.mode);
  const cycle = marketMakerModel?.cycle || {};
  const observation = marketMakerModel?.observation || {};
  const age = Number(triggerAgeBars);
  const freshM5 = freshImpulse === true && Number.isFinite(age) && age <= 1;
  const failures = [];
  const fail = (code, reason) => failures.push({ code, reason });

  if (!wanted || d1 !== wanted || h4 !== wanted || timeframeBias?.d1H4Aligned === false) {
    fail(ICT_FAILURE_CODES.HTF_DIRECTION_NOT_ALIGNED, 'D1 and H4 must agree with the intended trade direction.');
  }
  if (authorization?.ready !== true || !authorization?.cycleId) {
    fail(ICT_FAILURE_CODES.MISSING_M5_AUTHORIZATION, 'A concrete ICT authorization mode and stable cycle ID are required.');
  }
  if (!freshM5) {
    fail(ICT_FAILURE_CODES.STALE_M5_TRIGGER, `The M5 trigger is not fresh (age=${Number.isFinite(age) ? age : 'unknown'} bars; maximum=1).`);
  }

  if (family === 'continuation') {
    const transitionAligned = h1Transition?.ready === true && normalizeDirection(h1Transition?.bias) === wanted;
    const momentumAligned = h1Momentum?.activeAligned === true || h1Momentum?.aligned === true;
    if (!momentumAligned && !transitionAligned) {
      fail(
        h1Momentum?.exhausted === true
          ? ICT_FAILURE_CODES.H1_MOMENTUM_EXHAUSTED
          : ICT_FAILURE_CODES.H1_ACTIVE_MOMENTUM_NOT_ALIGNED,
        h1Momentum?.reason || 'H1 active momentum or a live H1 transition must align with D1/H4.',
      );
    }
  } else if (family === 'reversal') {
    const keyTap = marketMakerModel?.keyLevelTap?.aligned === true || Boolean(cycle?.keyLevel?.tappedAt);
    const swept = observation?.sweepAligned === true || Boolean(cycle?.manipulation?.time);
    const displaced = observation?.displacementFresh === true || Boolean(cycle?.displacement?.time);
    const reversalConfirmed = observation?.mssAligned === true ||
      observation?.cisd?.confirmed === true || observation?.inverseFvg?.confirmed === true ||
      concepts?.mss?.confirmed === true || concepts?.cisd?.confirmed === true;
    if (!keyTap) fail(ICT_FAILURE_CODES.HTF_LEVEL_NOT_TAPPED, 'Reversal requires a tapped D1/H4 key level.');
    if (!swept) fail(ICT_FAILURE_CODES.LIQUIDITY_SWEEP_MISSING, 'Reversal requires a liquidity sweep after the HTF tap.');
    if (!displaced) fail(ICT_FAILURE_CODES.OPPOSING_DISPLACEMENT_MISSING, 'Reversal requires displacement opposing the liquidity raid.');
    if (!reversalConfirmed) fail(ICT_FAILURE_CODES.CISD_MSS_MISSING, 'Reversal requires CISD, MSS, or an equivalent inverse-FVG confirmation.');
  } else {
    fail(ICT_FAILURE_CODES.UNKNOWN_ENTRY_FAMILY, `Authorization mode "${authorization?.mode || 'none'}" is neither a continuation nor a reversal.`);
  }

  return {
    passed: failures.length === 0,
    decision: failures.length === 0 ? 'authorize' : 'reject',
    family,
    direction: wanted,
    freshM5,
    triggerAgeBars: Number.isFinite(age) ? age : null,
    authorizationMode: authorization?.mode || 'none',
    authorizationCycleId: authorization?.cycleId || null,
    failureCodes: failures.map((item) => item.code),
    failureReasons: failures.map((item) => item.reason),
    rule: family === 'reversal'
      ? 'HTF tap + liquidity sweep + opposing displacement + CISD/MSS + fresh M5'
      : 'D1/H4 aligned + H1 active momentum/transition aligned + fresh M5',
  };
}
