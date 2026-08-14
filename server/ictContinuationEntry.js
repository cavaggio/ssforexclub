/**
 * ICT M5 continuation-entry authority.
 *
 * Daily/H4 still own direction. H1 is confirmation-only for this path: when it
 * already agrees with that higher-timeframe direction, a fresh M5 BOS/range
 * breakout or its first retest may authorize a new scalp without waiting for a
 * new countertrend-to-bias H1 candle transition.
 *
 * The classifier deliberately requires displacement plus an ICT PD array for a
 * direct breakout, caps extension from the broken level, and emits a stable
 * cycle id so a closed trade cannot reopen from the same impulse.
 */

const normalizeBias = (value) => {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'long' || normalized === 'buy' || normalized === 'bullish') return 'bullish';
  if (normalized === 'short' || normalized === 'sell' || normalized === 'bearish') return 'bearish';
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

function firstBreakTime(candles, direction, level, fallbackTime) {
  if (!Number.isFinite(level)) return fallbackTime ?? null;
  const list = Array.isArray(candles) ? candles : [];
  const start = Math.max(0, list.length - 8);
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
  bos = null,
  rangeBreakout = null,
  retest = null,
  displacement = null,
  fvgs = [],
  orderBlock = null,
  atrPrice = null,
  maxExtensionAtr = finite(process.env.ICT_M5_MAX_BREAKOUT_EXTENSION_ATR, 1.25),
} = {}) {
  const direction = normalizeBias(bias);
  const hourlyDirection = normalizeBias(h1Bias);
  const list = Array.isArray(candles) ? candles : [];
  const latest = list.at(-1) || null;
  const latestDirection = candleDirection(latest);
  const latestComplete = latest?.complete !== false;
  const atrValue = finite(atrPrice);
  const maxExtension = Math.max(0.25, finite(maxExtensionAtr, 1.25));

  const bosAligned = Boolean(direction && bos?.direction === direction);
  const rangeAligned = Boolean(direction && rangeBreakout?.direction === direction);
  const retestAligned = Boolean(direction && retest?.direction === direction);
  const displacementAligned = Boolean(direction && displacement?.direction === direction);
  const displacementAgeBars = displacementAligned && Number.isInteger(displacement?.candleIndex)
    ? Math.max(0, list.length - 1 - displacement.candleIndex)
    : null;
  const freshDisplacement = displacementAligned && Number.isFinite(displacementAgeBars) && displacementAgeBars <= 1;
  const fvgAligned = Boolean(direction && (Array.isArray(fvgs) ? fvgs : []).some(
    (fvg) => fvg?.type === direction && fvg?.status !== 'filled',
  ));
  const orderBlockAligned = Boolean(
    direction && orderBlock?.type === direction && orderBlock?.mitigated !== true,
  );
  const pdArrayAligned = fvgAligned || orderBlockAligned;

  const directBreakout = (bosAligned || rangeAligned) &&
    freshDisplacement &&
    (displacement?.createdFVG === true || pdArrayAligned);
  const confirmedRetest = retestAligned && pdArrayAligned;
  const mode = confirmedRetest
    ? 'm5_continuation_retest'
    : directBreakout ? 'm5_continuation_breakout' : null;

  const breakoutLevel = confirmedRetest
    ? finite(retest?.retestLevel)
    : bosAligned
      ? finite(bos?.brokenLevel)
      : rangeAligned
        ? finite(direction === 'bullish' ? rangeBreakout?.rangeHigh : rangeBreakout?.rangeLow)
        : null;
  const currentClose = finite(latest?.close);
  const extensionPrice = Number.isFinite(currentClose) && Number.isFinite(breakoutLevel)
    ? Math.max(0, direction === 'bullish' ? currentClose - breakoutLevel : breakoutLevel - currentClose)
    : null;
  const extensionAtr = Number.isFinite(extensionPrice) && Number.isFinite(atrValue) && atrValue > 0
    ? extensionPrice / atrValue
    : null;
  const overextended = Number.isFinite(extensionAtr) && extensionAtr > maxExtension;

  const displacementTime = Number.isInteger(displacement?.candleIndex)
    ? list[displacement.candleIndex]?.time
    : null;
  const anchorTime = firstBreakTime(
    list,
    direction,
    breakoutLevel,
    displacementTime || bos?.time || latest?.time || null,
  );
  const normalizedLevel = Number.isFinite(breakoutLevel)
    ? Number(breakoutLevel).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')
    : 'unknown';
  const cycleId = direction && mode && anchorTime
    ? `${direction}:${mode}:${normalizedLevel}:${anchorTime}`
    : null;

  let ready = true;
  let status = 'ready';
  let reason = confirmedRetest
    ? 'H1 confirms the Daily/H4 bias and M5 completed the first held retest of a fresh continuation break.'
    : 'H1 confirms the Daily/H4 bias and M5 closed a displacement breakout with an aligned ICT PD array.';

  if (!direction) {
    ready = false;
    status = 'no_htf_bias';
    reason = 'Daily/H4 continuation direction is unavailable.';
  } else if (hourlyDirection !== direction) {
    ready = false;
    status = 'h1_not_aligned';
    reason = `H1 analysis is ${hourlyDirection || 'neutral'}, not ${direction} with the Daily/H4 bias.`;
  } else if (!latest || list.length < 20) {
    ready = false;
    status = 'insufficient_m5';
    reason = 'At least 20 M5 candles are required for continuation-breakout confirmation.';
  } else if (!latestComplete) {
    ready = false;
    status = 'await_m5_close';
    reason = 'The M5 breakout candle is still live; wait for its confirming close.';
  } else if (!mode) {
    ready = false;
    status = 'no_m5_continuation';
    reason = 'No fresh aligned M5 continuation trigger is present.';
  } else if (mode === 'm5_continuation_breakout' && latestDirection !== direction) {
    ready = false;
    status = 'breakout_candle_conflict';
    reason = `The confirming M5 candle is ${latestDirection}, not ${direction}.`;
  } else if (!Number.isFinite(extensionAtr)) {
    ready = false;
    status = 'missing_extension_measure';
    reason = 'M5 breakout extension could not be measured against ATR.';
  } else if (overextended) {
    ready = false;
    status = 'breakout_overextended';
    reason = `M5 price is ${extensionAtr.toFixed(2)} ATR beyond the broken level; the ${maxExtension.toFixed(2)} ATR continuation-entry limit prevents chasing.`;
  } else if (!cycleId) {
    ready = false;
    status = 'missing_cycle_id';
    reason = 'The M5 continuation breakout could not be assigned a stable execution cycle.';
  }

  return {
    ready,
    status,
    reason,
    mode,
    direction,
    h1Bias: hourlyDirection,
    breakoutLevel,
    anchorTime,
    cycleId,
    bosAligned,
    rangeAligned,
    retestAligned,
    displacementAligned,
    displacementAgeBars,
    fvgAligned,
    orderBlockAligned,
    extensionAtr: Number.isFinite(extensionAtr) ? +extensionAtr.toFixed(3) : null,
    maxExtensionAtr: maxExtension,
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
      reason: continuationBreakout.reason || 'Fresh M5 continuation breakout is ready.',
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
