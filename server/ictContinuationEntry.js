/**
 * ICT M5 continuation-entry authority.
 *
 * Daily/H4 own direction. H1/current-session context confirms the path, while
 * completed M5 structure owns the executable trigger. A fresh breakout is kept
 * alive for a short authorization window so a scan boundary cannot erase it.
 * If price is already extended, the model arms a recovery/retest path instead
 * of chasing the impulse or forgetting the trend.
 */

const normalizeBias = (value) => {
  const normalized = String(value || '').toLowerCase();
  if (['long', 'buy', 'bullish'].includes(normalized)) return 'bullish';
  if (['short', 'sell', 'bearish'].includes(normalized)) return 'bearish';
  return null;
};

const finite = (value, fallback = null) => {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const candleDirection = (candle) => {
  const open = finite(candle?.open);
  const close = finite(candle?.close);
  if (!Number.isFinite(open) || !Number.isFinite(close) || close === open) return 'neutral';
  return close > open ? 'bullish' : 'bearish';
};

const parseMs = (value) => {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : null;
};

function completedCandles(candles) {
  return (Array.isArray(candles) ? candles : [])
    .filter((candle) => candle?.complete !== false)
    .filter((candle) => [candle?.open, candle?.high, candle?.low, candle?.close]
      .every((value) => Number.isFinite(finite(value))));
}

function triggerAgeMinutes(eventTime, now, ageBars = null) {
  const eventMs = parseMs(eventTime);
  const nowMs = now instanceof Date ? now.getTime() : parseMs(now);
  const confirmedAtMs = Number.isFinite(eventMs) ? eventMs + (5 * 60_000) : null;
  if (Number.isFinite(confirmedAtMs) && Number.isFinite(nowMs)) {
    if (nowMs <= confirmedAtMs) return 0;
    return +((nowMs - confirmedAtMs) / 60_000).toFixed(2);
  }
  return Number.isFinite(ageBars) ? ageBars * 5 : null;
}

function findRecentStructuralBreak({
  candles,
  direction,
  atrPrice,
  lookbackBars = 8,
  searchBars = 12,
  minBodyAtr = 0.35,
} = {}) {
  const list = completedCandles(candles);
  const atrValue = finite(atrPrice);
  if (!direction || list.length < lookbackBars + 2 || !Number.isFinite(atrValue) || atrValue <= 0) return null;

  const lastIndex = list.length - 1;
  const startIndex = Math.max(lookbackBars, lastIndex - Math.max(2, Number(searchBars) || 12));

  for (let index = lastIndex; index >= startIndex; index -= 1) {
    const candle = list[index];
    if (candleDirection(candle) !== direction) continue;
    const prior = list.slice(Math.max(0, index - lookbackBars), index);
    if (prior.length < Math.min(6, lookbackBars)) continue;

    const level = direction === 'bullish'
      ? Math.max(...prior.map((item) => finite(item.high)))
      : Math.min(...prior.map((item) => finite(item.low)));
    const close = finite(candle.close);
    const open = finite(candle.open);
    const body = Math.abs(close - open);
    const bodyAtr = body / atrValue;
    const crossed = direction === 'bullish' ? close > level : close < level;
    if (!crossed || bodyAtr < minBodyAtr) continue;

    // A new cycle must emerge from a pause/pullback/compression; otherwise a
    // straight trend could mint a new cycle on every candle and overtrade.
    const prior4 = prior.slice(-4);
    const mixedBodies = prior4.some((item) => candleDirection(item) !== direction);
    const priorRange = Math.max(...prior.map((item) => finite(item.high))) -
      Math.min(...prior.map((item) => finite(item.low)));
    const compressed = priorRange <= atrValue * 3.0;
    if (!mixedBodies && !compressed) continue;

    return {
      index,
      time: candle.time ?? null,
      level,
      ageBars: lastIndex - index,
      bodyAtr: +bodyAtr.toFixed(3),
      source: 'completed_m5_structure_break',
    };
  }
  return null;
}

function pullbackBeforeEvent({ candles, direction, eventIndex, atrPrice } = {}) {
  const list = completedCandles(candles);
  const atrValue = finite(atrPrice);
  if (!Number.isInteger(eventIndex) || eventIndex < 1 || !Number.isFinite(atrValue) || atrValue <= 0) return false;
  const prior = list.slice(Math.max(0, eventIndex - 5), eventIndex);
  return prior.some((candle) => {
    if (candleDirection(candle) !== direction) return true;
    const body = Math.abs(finite(candle.close) - finite(candle.open));
    return body <= atrValue * 0.12;
  });
}

function firstBreakTime(candles, direction, level, fallbackTime) {
  if (!Number.isFinite(level)) return fallbackTime ?? null;
  const list = completedCandles(candles);
  const start = Math.max(0, list.length - 12);
  for (let index = start; index < list.length; index += 1) {
    const close = finite(list[index]?.close);
    const priorClose = index > 0 ? finite(list[index - 1]?.close) : null;
    const beyond = direction === 'bullish' ? close > level : close < level;
    const priorBeyond = Number.isFinite(priorClose)
      ? (direction === 'bullish' ? priorClose > level : priorClose < level)
      : false;
    if (beyond && !priorBeyond) return list[index]?.time ?? fallbackTime ?? null;
  }
  return fallbackTime ?? null;
}

export function classifyIctM5ContinuationEntry({
  candles = [],
  bias,
  h1Bias,
  h1Momentum = null,
  h1Transition = null,
  earlySessionDirection = null,
  bos = null,
  rangeBreakout = null,
  retest = null,
  displacement = null,
  fvgs = [],
  orderBlock = null,
  atrPrice = null,
  now = null,
  maxExtensionAtr = finite(process.env.ICT_M5_MAX_BREAKOUT_EXTENSION_ATR, 2.5),
  maxTriggerAgeMinutes = finite(process.env.ICT_M5_TRIGGER_MAX_AGE_MINUTES, 10),
  recoveryLookbackBars = finite(process.env.ICT_M5_RECOVERY_LOOKBACK_BARS, 12),
} = {}) {
  const direction = normalizeBias(bias);
  const hourlyDirection = normalizeBias(h1Bias);
  const currentH1Opposing = h1Momentum?.currentOpposing === true;
  const activeMomentumAligned = h1Momentum?.currentAligned === true ||
    h1Momentum?.activeAligned === true || h1Momentum?.aligned === true;
  const transitionAligned = h1Transition?.ready === true && normalizeBias(h1Transition?.bias) === direction;
  const earlySessionAligned = earlySessionDirection?.alignedWithBias === true &&
    Number(earlySessionDirection?.completedCount || 0) >= 2;
  const hourlyMomentumConfirmed = !currentH1Opposing &&
    (activeMomentumAligned || transitionAligned || earlySessionAligned);

  const list = Array.isArray(candles) ? candles : [];
  const completed = completedCandles(list);
  const latest = list.at(-1) || null;
  const latestCompleted = completed.at(-1) || null;
  const atrValue = finite(atrPrice);
  // Retire the old 1.25 ATR choke point. A fresh breakout may breathe, but
  // genuinely extended price still cannot be market-chased.
  const maxExtension = Math.max(2.0, finite(maxExtensionAtr, 2.5));
  const maxAgeMinutes = Math.max(5, finite(maxTriggerAgeMinutes, 10));
  const recoveryBars = Math.max(4, Math.round(finite(recoveryLookbackBars, 12)));

  const bosAligned = Boolean(direction && bos?.direction === direction);
  const rangeAligned = Boolean(direction && rangeBreakout?.direction === direction);
  const retestAligned = Boolean(direction && retest?.direction === direction);
  const displacementAligned = Boolean(direction && displacement?.direction === direction);
  const fvgAligned = Boolean(direction && (Array.isArray(fvgs) ? fvgs : []).some(
    (fvg) => fvg?.type === direction && fvg?.status !== 'filled',
  ));
  const orderBlockAligned = Boolean(
    direction && orderBlock?.type === direction && orderBlock?.mitigated !== true,
  );
  const pdArrayAligned = fvgAligned || orderBlockAligned;

  const recentBreak = findRecentStructuralBreak({
    candles: completed,
    direction,
    atrPrice: atrValue,
    searchBars: recoveryBars,
  });

  const externalLevel = bosAligned
    ? finite(bos?.brokenLevel)
    : rangeAligned
      ? finite(direction === 'bullish' ? rangeBreakout?.rangeHigh : rangeBreakout?.rangeLow)
      : null;
  const externalTime = bosAligned ? bos?.time : rangeAligned ? rangeBreakout?.time : null;
  const completedTimes = new Set(completed.map((candle) => candle?.time).filter(Boolean));
  const externalIsCompleted = externalTime ? completedTimes.has(externalTime) : Boolean(latestCompleted);
  const externalIndex = externalTime
    ? completed.findIndex((candle) => candle?.time === externalTime)
    : completed.length - 1;
  const externalCandle = externalIndex >= 0 ? completed[externalIndex] : null;
  const externalBody = externalCandle
    ? Math.abs(finite(externalCandle.close) - finite(externalCandle.open))
    : null;
  const externalBodyAtr = Number.isFinite(externalBody) && Number.isFinite(atrValue) && atrValue > 0
    ? externalBody / atrValue
    : null;
  const externalDecisive = displacementAligned || (Number.isFinite(externalBodyAtr) && externalBodyAtr >= 0.35);
  const externalEvent = Number.isFinite(externalLevel) && externalIsCompleted && externalIndex >= 0 && externalDecisive
    ? {
        time: externalTime || latestCompleted?.time || null,
        level: externalLevel,
        ageBars: Math.max(0, completed.length - 1 - externalIndex),
        source: bosAligned ? 'bos' : 'range_breakout',
        index: externalIndex,
      }
    : null;

  // Prefer the newest completed structural event. This is the key fix for the
  // missed-breakout scan boundary: the event survives after a new live M5 opens.
  const breakoutEvent = [externalEvent, recentBreak].filter(Boolean).sort((a, b) => {
    const aMs = parseMs(a.time) ?? 0;
    const bMs = parseMs(b.time) ?? 0;
    return bMs - aMs;
  })[0] || null;

  const retestLevel = finite(retest?.retestLevel);
  const retestEvent = retestAligned && latestCompleted && Number.isFinite(retestLevel)
    ? {
        time: latestCompleted.time ?? null,
        level: retestLevel,
        ageBars: 0,
        source: 'held_retest',
        index: completed.length - 1,
      }
    : null;

  const selectedEvent = retestEvent || breakoutEvent;
  const ageMinutes = selectedEvent
    ? triggerAgeMinutes(selectedEvent.time, now || latest?.time || latestCompleted?.time, selectedEvent.ageBars)
    : null;
  const triggerFresh = Number.isFinite(ageMinutes) && ageMinutes <= maxAgeMinutes;

  const breakoutLevel = finite(selectedEvent?.level);
  const currentClose = finite(latest?.close, finite(latestCompleted?.close));
  const extensionPrice = Number.isFinite(currentClose) && Number.isFinite(breakoutLevel)
    ? Math.max(0, direction === 'bullish' ? currentClose - breakoutLevel : breakoutLevel - currentClose)
    : null;
  const extensionAtr = Number.isFinite(extensionPrice) && Number.isFinite(atrValue) && atrValue > 0
    ? extensionPrice / atrValue
    : null;
  const overextended = Number.isFinite(extensionAtr) && extensionAtr > maxExtension;

  const recoveryFromPullback = breakoutEvent && pullbackBeforeEvent({
    candles: completed,
    direction,
    eventIndex: breakoutEvent.index,
    atrPrice: atrValue,
  });
  const mode = retestEvent
    ? 'm5_continuation_recovery'
    : breakoutEvent ? 'm5_continuation_breakout' : null;

  const anchorTime = selectedEvent
    ? firstBreakTime(completed, direction, breakoutLevel, selectedEvent.time)
    : null;
  const normalizedLevel = Number.isFinite(breakoutLevel)
    ? Number(breakoutLevel).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')
    : 'unknown';
  const cycleId = direction && mode && anchorTime
    ? `${direction}:${mode}:${normalizedLevel}:${anchorTime}`
    : null;

  const recoveryArmed = Boolean(direction && breakoutEvent && (
    overextended || !triggerFresh || mode === 'm5_continuation_recovery'
  ));

  let ready = true;
  let status = 'ready';
  let reason = mode === 'm5_continuation_recovery'
    ? 'D1/H4 direction and H1/session context remain aligned; M5 produced a fresh recovery retest/re-break after the prior impulse.'
    : 'D1/H4 direction and H1/session context remain aligned; a recent completed M5 structural breakout is still inside the 10-minute execution window.';

  if (!direction) {
    ready = false;
    status = 'no_htf_bias';
    reason = 'Daily/H4 continuation direction is unavailable.';
  } else if (!hourlyMomentumConfirmed) {
    ready = false;
    status = currentH1Opposing || h1Momentum?.exhausted === true
      ? 'h1_momentum_exhausted'
      : 'h1_momentum_not_aligned';
    reason = h1Momentum?.reason ||
      `Neither active/current H1 nor the completed 01:00-03:00 ET narrative confirms ${direction}.`;
  } else if (completed.length < 20) {
    ready = false;
    status = 'insufficient_m5';
    reason = 'At least 20 completed M5 candles are required for continuation-breakout confirmation.';
  } else if (!mode || !selectedEvent) {
    ready = false;
    status = 'no_m5_continuation';
    reason = 'No recent completed M5 breakout, held retest, or recovery re-break is present.';
  } else if (!triggerFresh) {
    ready = false;
    status = 'await_recovery_pullback';
    reason = `The last M5 breakout trigger is ${Number.isFinite(ageMinutes) ? ageMinutes.toFixed(1) : 'unknown'} minutes old; do not chase it. Keep the trend armed for the first fresh pullback/re-break.`;
  } else if (!Number.isFinite(extensionAtr)) {
    ready = false;
    status = 'missing_extension_measure';
    reason = 'M5 breakout extension could not be measured against ATR.';
  } else if (overextended) {
    ready = false;
    status = 'await_recovery_pullback';
    reason = `M5 price is ${extensionAtr.toFixed(2)} ATR beyond the newest breakout level; do not chase. Recovery is armed for the first fresh M5 retest/re-break.`;
  } else if (!cycleId) {
    ready = false;
    status = 'missing_cycle_id';
    reason = 'The M5 continuation trigger could not be assigned a stable execution cycle.';
  }

  return {
    ready,
    status,
    reason,
    mode,
    direction,
    h1Bias: hourlyDirection,
    h1MomentumAligned: activeMomentumAligned,
    h1TransitionAligned: transitionAligned,
    earlySessionAligned,
    currentH1Opposing,
    breakoutLevel,
    breakoutSource: selectedEvent?.source || null,
    breakoutTime: selectedEvent?.time || null,
    anchorTime,
    cycleId,
    bosAligned,
    rangeAligned,
    retestAligned,
    displacementAligned,
    fvgAligned,
    orderBlockAligned,
    pdArrayAligned,
    triggerAgeBars: Number.isFinite(selectedEvent?.ageBars) ? selectedEvent.ageBars : null,
    triggerAgeMinutes: ageMinutes,
    maxTriggerAgeMinutes: maxAgeMinutes,
    triggerFresh,
    extensionAtr: Number.isFinite(extensionAtr) ? +extensionAtr.toFixed(3) : null,
    maxExtensionAtr: maxExtension,
    overextended,
    recoveryArmed,
    recoveryLookbackBars: recoveryBars,
    rule: 'fresh completed breakout OR first recovery retest/re-break; PD arrays are confluence, not mandatory',
  };
}

export function resolveIctEntryAuthorization({ h1Transition = null, continuationBreakout = null } = {}) {
  if (h1Transition?.ready === true && h1Transition?.transitionId) {
    return {
      ready: true,
      mode: 'h1_transition',
      cycleId: String(h1Transition.transitionId),
      reason: h1Transition.reason || 'Fresh H1 countertrend-to-bias transition is ready.',
    };
  }
  if (continuationBreakout?.ready === true && continuationBreakout?.cycleId) {
    return {
      ready: true,
      mode: continuationBreakout.mode || 'm5_continuation_breakout',
      cycleId: String(continuationBreakout.cycleId),
      reason: continuationBreakout.reason || 'Fresh M5 continuation breakout/recovery is ready.',
    };
  }
  return {
    ready: false,
    mode: 'none',
    cycleId: null,
    reason:
      `H1 transition unavailable: ${h1Transition?.reason || 'not ready'}. ` +
      `M5 continuation unavailable: ${continuationBreakout?.reason || 'not ready'}.`,
  };
}
