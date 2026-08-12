/**
 * ICT hourly entry timing authority.
 *
 * Direction is owned by the Daily/H4 agreement. Entry is allowed only during
 * the opening portion of a live H1 candle that has turned back into that bias
 * immediately after the last completed H1 candle moved against it.
 *
 * This is deliberately independent from confidence. A high confidence score
 * cannot promote an entry after the hourly transition window has passed.
 */

const sign = (value) => {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'long' || normalized === 'buy' || normalized === 'bullish') return 'bullish';
  if (normalized === 'short' || normalized === 'sell' || normalized === 'bearish') return 'bearish';
  return null;
};

const candleDirection = (candle) => {
  const open = Number(candle?.open);
  const close = Number(candle?.close);
  if (!Number.isFinite(open) || !Number.isFinite(close) || close === open) return 'neutral';
  return close > open ? 'bullish' : 'bearish';
};

const finite = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function classifyIctHourlyEntryTransition({
  h1Candles = [],
  bias,
  now = new Date(),
  maxEntryMinutes = finite(process.env.ICT_H1_ENTRY_WINDOW_MINUTES, 20),
  maxRangeFraction = finite(process.env.ICT_H1_MAX_TRANSITION_RANGE_FRACTION, 0.35),
} = {}) {
  const htfBias = sign(bias);
  const candles = Array.isArray(h1Candles) ? h1Candles : [];
  const current = candles.at(-1) || null;
  const currentIsLive = current?.complete === false;
  const previous = currentIsLive ? candles.at(-2) || null : current;
  const expectedCounter = htfBias === 'bullish' ? 'bearish' : htfBias === 'bearish' ? 'bullish' : null;
  const currentDirection = candleDirection(current);
  const previousDirection = candleDirection(previous);
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const openedAtMs = Date.parse(String(current?.time || ''));
  const minutesIntoCandle = Number.isFinite(nowMs) && Number.isFinite(openedAtMs)
    ? Math.max(0, (nowMs - openedAtMs) / 60000)
    : null;

  const previousRange = Number(previous?.high) - Number(previous?.low);
  const currentBody = Math.abs(Number(current?.close) - Number(current?.open));
  const transitionRangeFraction = Number.isFinite(previousRange) && previousRange > 0 && Number.isFinite(currentBody)
    ? currentBody / previousRange
    : null;

  let ready = true;
  let status = 'ready';
  let reason = 'Live H1 candle has turned back into the Daily/H4 bias after one completed counter-bias H1 candle.';

  if (!htfBias) {
    ready = false;
    status = 'no_htf_bias';
    reason = 'Daily/H4 directional bias is not available.';
  } else if (candles.length < 2 || !current || !previous) {
    ready = false;
    status = 'insufficient_h1';
    reason = 'At least one completed H1 candle and the current live H1 candle are required.';
  } else if (!currentIsLive) {
    ready = false;
    status = 'await_live_h1';
    reason = 'The current live H1 candle is unavailable; a closed H1 candle cannot authorize a new entry.';
  } else if (previousDirection !== expectedCounter) {
    ready = false;
    status = 'await_countertrend_close';
    reason = `The last completed H1 candle was ${previousDirection}, not ${expectedCounter} against the ${htfBias} Daily/H4 bias.`;
  } else if (currentDirection !== htfBias) {
    ready = false;
    status = 'await_bias_turn';
    reason = `The live H1 candle is ${currentDirection}; wait for it to turn ${htfBias} with the Daily/H4 bias.`;
  } else if (!Number.isFinite(minutesIntoCandle) || minutesIntoCandle > Math.max(1, maxEntryMinutes)) {
    ready = false;
    status = 'late_hourly_entry';
    reason = `The live H1 candle is ${Number.isFinite(minutesIntoCandle) ? minutesIntoCandle.toFixed(1) : '?'} minutes old; the ${Math.max(1, maxEntryMinutes)}-minute transition window has ended.`;
  } else if (
    Number.isFinite(transitionRangeFraction) &&
    transitionRangeFraction > Math.max(0.05, maxRangeFraction)
  ) {
    ready = false;
    status = 'hourly_momentum_consumed';
    reason = `The live H1 body has already consumed ${(transitionRangeFraction * 100).toFixed(0)}% of the prior countertrend H1 range; do not chase the end of momentum.`;
  }

  return {
    ready,
    status,
    reason,
    bias: htfBias,
    previousDirection,
    currentDirection,
    previousCandleTime: previous?.time ?? null,
    currentCandleTime: current?.time ?? null,
    currentCandleComplete: current?.complete !== false,
    minutesIntoCandle: Number.isFinite(minutesIntoCandle) ? +minutesIntoCandle.toFixed(2) : null,
    transitionRangeFraction: Number.isFinite(transitionRangeFraction)
      ? +transitionRangeFraction.toFixed(4)
      : null,
    transitionId: htfBias && current?.time ? `${htfBias}:${current.time}` : null,
  };
}
