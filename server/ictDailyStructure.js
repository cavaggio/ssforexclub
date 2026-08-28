/**
 * Daily ICT structure model.
 *
 * Daily direction is intentionally separated into three horizons:
 *   - 5-7 closed candles: active confirmation / primary direction
 *   - 20 closed candles: structural context only
 *   - 1-3 closed candles: recency / entry-state weighting
 *
 * The 20-candle context never receives equal directional weight with the
 * active window. Recent opposing delivery can neutralize a stale active bias.
 */

const DAILY_ACTIVE_MIN = 5;
const DAILY_ACTIVE_MAX = 7;
const DAILY_CONTEXT = 20;
const DAILY_RECENCY = 3;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function body(candle) {
  return Math.abs(Number(candle?.close) - Number(candle?.open));
}

function range(candle) {
  const high = numeric(candle?.high);
  const low = numeric(candle?.low);
  return high != null && low != null ? Math.max(1e-9, high - low) : 1e-9;
}

function directionOf(candle) {
  const open = numeric(candle?.open);
  const close = numeric(candle?.close);
  if (open == null || close == null || close === open) return 0;
  return close > open ? 1 : -1;
}

function windowRead(candles) {
  if (!candles.length) {
    return {
      bias: 'neutral',
      structuralBull: false,
      structuralBear: false,
      net: 0,
      span: 0,
      normalizedNet: 0,
      directionalScore: 0,
    };
  }

  const highs = candles.map((c) => numeric(c.high)).filter(Number.isFinite);
  const lows = candles.map((c) => numeric(c.low)).filter(Number.isFinite);
  const opens = candles.map((c) => numeric(c.open)).filter(Number.isFinite);
  const closes = candles.map((c) => numeric(c.close)).filter(Number.isFinite);
  const span = highs.length && lows.length ? Math.max(...highs) - Math.min(...lows) : 0;
  const net = closes.length && opens.length ? closes[closes.length - 1] - opens[0] : 0;
  const normalizedNet = span > 0 ? net / span : 0;

  // With only 5-7 candles, direct local swing comparisons are more reliable
  // than comparing against the much older 20-candle context.
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

  const directionalScore = normalizedNet +
    (structuralBull ? 0.35 : 0) -
    (structuralBear ? 0.35 : 0);

  const bias = structuralBull && net > 0
    ? 'bullish'
    : structuralBear && net < 0
      ? 'bearish'
      : Math.abs(normalizedNet) >= 0.22
        ? (net > 0 ? 'bullish' : 'bearish')
        : 'neutral';

  return {
    bias,
    structuralBull,
    structuralBear,
    net,
    span,
    normalizedNet,
    directionalScore,
  };
}

/**
 * Compute Daily bias using the requested ICT hierarchy.
 */
export function computeDailyStructure({ dailyCandles = [], currentPrice = null }) {
  const closed = (Array.isArray(dailyCandles) ? dailyCandles : [])
    .filter((candle) => candle && candle.complete !== false);

  const context = closed.slice(-DAILY_CONTEXT);
  const active = closed.slice(-DAILY_ACTIVE_MAX);
  const recent = closed.slice(-DAILY_RECENCY);

  if (closed.length < DAILY_ACTIVE_MIN) {
    return {
      dailyBias: 'neutral',
      qualified: false,
      reason: `Need at least ${DAILY_ACTIVE_MIN} completed Daily candles for active confirmation.`,
      activeBias: 'neutral',
      contextBias: 'neutral',
      recencyBias: 'neutral',
      activeWindow: { candles: active.length, minimum: DAILY_ACTIVE_MIN, maximum: DAILY_ACTIVE_MAX },
      contextWindow: { candles: context.length, maximum: DAILY_CONTEXT },
      recencyWindow: { candles: recent.length, maximum: DAILY_RECENCY },
      recencyScore: 0,
      activeStrength: 0,
      contextStrength: 0,
      invalidatedByRecency: false,
      currentPrice: numeric(currentPrice),
    };
  }

  const activeRead = windowRead(active);
  const contextRead = windowRead(context);

  // Recency is deliberately weighted by age: newest candle has the most
  // influence, but the 3-candle sequence is still a delivery-state read.
  const weights = [1.0, 0.85, 0.7].slice(-recent.length);
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

  // Primary direction belongs to the active 5-7 candle window. A strong,
  // opposite 1-3 candle delivery sequence can neutralize a stale active read,
  // but it does not silently flip the Daily bias by itself.
  if (dailyBias !== 'neutral' && recencyBias !== 'neutral' && recencyBias !== dailyBias && Math.abs(recencyScore) >= 0.42) {
    dailyBias = 'neutral';
    invalidatedByRecency = true;
  } else if (dailyBias === 'neutral' && recencyBias !== 'neutral') {
    dailyBias = recencyBias;
  }

  const current = numeric(currentPrice);
  const currentState = current != null && closed.length
    ? {
        aboveLastHigh: current > Number(closed[closed.length - 1].high),
        belowLastLow: current < Number(closed[closed.length - 1].low),
        aboveLastClose: current > Number(closed[closed.length - 1].close),
        belowLastClose: current < Number(closed[closed.length - 1].close),
      }
    : null;

  const reasons = [
    `Daily active window=${active.length} candles (primary confirmation).`,
    `Daily active read=${activeRead.bias}.`,
    `Daily recency window=${recent.length} candles (entry-state weighting) read=${recencyBias}.`,
    `Daily context window=${context.length} candles (structural context only) read=${contextRead.bias}.`,
  ];
  if (invalidatedByRecency) reasons.push('Recent 1-3 candle delivery opposes active bias strongly enough to neutralize stale direction.');

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
