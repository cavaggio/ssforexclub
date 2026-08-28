/**
 * Daily ICT structure model.
 *
 * Direction owner: latest 5-7 completed Daily candles.
 * Context: latest 20 completed candles, structural only.
 * Recency: latest 1-3 completed candles, entry-state weighting only.
 *
 * Recency may neutralize a stale active bias, but it may never promote a
 * neutral active window into a new directional Daily bias.
 */

const DAILY_ACTIVE_MIN = 5;
const DAILY_ACTIVE_MAX = 7;
const DAILY_CONTEXT = 20;
const DAILY_RECENCY = 3;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const numeric = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const body = (candle) => Math.abs(Number(candle?.close) - Number(candle?.open));
const range = (candle) => {
  const high = numeric(candle?.high);
  const low = numeric(candle?.low);
  return high != null && low != null ? Math.max(1e-9, high - low) : 1e-9;
};
const directionOf = (candle) => {
  const open = numeric(candle?.open);
  const close = numeric(candle?.close);
  if (open == null || close == null || close === open) return 0;
  return close > open ? 1 : -1;
};

function windowRead(candles, { majorityBias = false } = {}) {
  if (!candles.length) {
    return { bias: 'neutral', structuralBull: false, structuralBear: false, net: 0, span: 0, normalizedNet: 0, directionalScore: 0, bullVotes: 0, bearVotes: 0, neutralVotes: 0 };
  }

  const highs = candles.map((c) => numeric(c.high)).filter(Number.isFinite);
  const lows = candles.map((c) => numeric(c.low)).filter(Number.isFinite);
  const opens = candles.map((c) => numeric(c.open)).filter(Number.isFinite);
  const closes = candles.map((c) => numeric(c.close)).filter(Number.isFinite);
  const span = highs.length && lows.length ? Math.max(...highs) - Math.min(...lows) : 0;
  const net = closes.length && opens.length ? closes[closes.length - 1] - opens[0] : 0;
  const normalizedNet = span > 0 ? net / span : 0;

  let structuralBull = false;
  let structuralBear = false;
  if (candles.length >= 5) {
    const mid = Math.max(2, Math.floor(candles.length / 2));
    const left = candles.slice(0, mid);
    const right = candles.slice(mid);
    const leftHigh = Math.max(...left.map((c) => Number(c.high)));
    const rightHigh = Math.max(...right.map((c) => Number(c.high)));
    const leftLow = Math.min(...left.map((c) => Number(c.low)));
    const rightLow = Math.min(...right.map((c) => Number(c.low)));
    structuralBull = rightHigh > leftHigh && rightLow > leftLow;
    structuralBear = rightHigh < leftHigh && rightLow < leftLow;
  }

  let bullVotes = 0;
  let bearVotes = 0;
  let neutralVotes = 0;
  for (const candle of candles) {
    const dir = directionOf(candle);
    if (dir > 0) bullVotes += 1;
    else if (dir < 0) bearVotes += 1;
    else neutralVotes += 1;
  }

  const voteMargin = (bullVotes - bearVotes) / candles.length;
  const directionalScore = majorityBias
    ? voteMargin
    : normalizedNet + (structuralBull ? 0.35 : 0) - (structuralBear ? 0.35 : 0);

  const bias = majorityBias
    ? bullVotes > bearVotes ? 'bullish' : bearVotes > bullVotes ? 'bearish' : 'neutral'
    : structuralBull && net > 0
      ? 'bullish'
      : structuralBear && net < 0
        ? 'bearish'
        : Math.abs(normalizedNet) >= 0.22
          ? (net > 0 ? 'bullish' : 'bearish')
          : 'neutral';

  return { bias, structuralBull, structuralBear, net, span, normalizedNet, directionalScore, bullVotes, bearVotes, neutralVotes };
}

export function computeDailyStructure({ dailyCandles = [], currentPrice = null }) {
  const closed = (Array.isArray(dailyCandles) ? dailyCandles : [])
    .filter((candle) => candle && candle.complete !== false);
  const context = closed.slice(-DAILY_CONTEXT);
  const active = closed.slice(-DAILY_ACTIVE_MAX);
  const recent = closed.slice(-DAILY_RECENCY);

  if (closed.length < DAILY_ACTIVE_MIN) {
    return {
      dailyBias: 'neutral', qualified: false,
      reason: `Need at least ${DAILY_ACTIVE_MIN} completed Daily candles for active confirmation.`,
      activeBias: 'neutral', contextBias: 'neutral', recencyBias: 'neutral',
      activeWindow: { candles: active.length, minimum: DAILY_ACTIVE_MIN, maximum: DAILY_ACTIVE_MAX },
      contextWindow: { candles: context.length, maximum: DAILY_CONTEXT },
      recencyWindow: { candles: recent.length, maximum: DAILY_RECENCY },
      recencyScore: 0, activeStrength: 0, contextStrength: 0,
      invalidatedByRecency: false, currentPrice: numeric(currentPrice),
    };
  }

  // The latest 5-7 completed Daily candles own direction. A simple majority
  // prevents older net travel from keeping a stale bullish/bearish bias alive.
  const activeRead = windowRead(active, { majorityBias: true });
  const contextRead = windowRead(context);

  // Newest candle receives the largest recency weight, but recency is never
  // allowed to create direction when the active window is neutral.
  const weights = [0.7, 0.85, 1.0].slice(-recent.length);
  let weighted = 0;
  let weightTotal = 0;
  recent.forEach((candle, index) => {
    const w = weights[index];
    const dir = directionOf(candle);
    const bodyPct = body(candle) / range(candle);
    weighted += dir * w * (0.65 + clamp(bodyPct, 0, 1) * 0.35);
    weightTotal += w;
  });
  const recencyScore = weightTotal > 0 ? weighted / weightTotal : 0;
  const recencyBias = Math.abs(recencyScore) >= 0.18
    ? (recencyScore > 0 ? 'bullish' : 'bearish')
    : 'neutral';

  let dailyBias = activeRead.bias;
  let invalidatedByRecency = false;

  // Strong opposing recent delivery can neutralize an active bias. It cannot
  // flip the bias and it cannot promote a neutral active window.
  if (
    dailyBias !== 'neutral' &&
    recencyBias !== 'neutral' &&
    recencyBias !== dailyBias &&
    Math.abs(recencyScore) >= 0.42
  ) {
    dailyBias = 'neutral';
    invalidatedByRecency = true;
  }

  const current = numeric(currentPrice);
  const lastClosed = closed[closed.length - 1];
  const currentState = current != null && lastClosed
    ? {
        aboveLastHigh: current > Number(lastClosed.high),
        belowLastLow: current < Number(lastClosed.low),
        aboveLastClose: current > Number(lastClosed.close),
        belowLastClose: current < Number(lastClosed.close),
      }
    : null;

  const reasons = [
    `Daily active window=${active.length} candles (primary confirmation).`,
    `Daily active read=${activeRead.bias} (${activeRead.bullVotes} bullish / ${activeRead.bearVotes} bearish / ${activeRead.neutralVotes} neutral).`,
    `Daily recency window=${recent.length} candles (entry-state weighting) read=${recencyBias}.`,
    `Daily context window=${context.length} candles (structural context only) read=${contextRead.bias}.`,
  ];
  if (invalidatedByRecency) {
    reasons.push('Recent 1-3 candle delivery opposes active bias strongly enough to neutralize stale direction.');
  }

  return {
    dailyBias,
    qualified: true,
    reason: reasons.join(' '),
    activeBias: activeRead.bias,
    contextBias: contextRead.bias,
    recencyBias,
    activeWindow: {
      candles: active.length,
      minimum: DAILY_ACTIVE_MIN,
      maximum: DAILY_ACTIVE_MAX,
      structuralBull: activeRead.structuralBull,
      structuralBear: activeRead.structuralBear,
      bullVotes: activeRead.bullVotes,
      bearVotes: activeRead.bearVotes,
      neutralVotes: activeRead.neutralVotes,
      net: activeRead.net,
      normalizedNet: +activeRead.normalizedNet.toFixed(4),
    },
    contextWindow: {
      candles: context.length,
      maximum: DAILY_CONTEXT,
      structuralBull: contextRead.structuralBull,
      structuralBear: contextRead.structuralBear,
      high: Math.max(...context.map((c) => Number(c.high))),
      low: Math.min(...context.map((c) => Number(c.low))),
      net: contextRead.net,
    },
    recencyWindow: {
      candles: recent.length,
      maximum: DAILY_RECENCY,
      weightedScore: +recencyScore.toFixed(4),
    },
    recencyScore: +recencyScore.toFixed(4),
    activeStrength: +Math.abs(activeRead.directionalScore).toFixed(4),
    contextStrength: +Math.abs(contextRead.directionalScore).toFixed(4),
    invalidatedByRecency,
    currentPrice: current,
    currentState,
  };
}

export const ICT_DAILY_WINDOWS = Object.freeze({
  ACTIVE_MIN: DAILY_ACTIVE_MIN,
  ACTIVE_MAX: DAILY_ACTIVE_MAX,
  CONTEXT: DAILY_CONTEXT,
  RECENCY: DAILY_RECENCY,
});
