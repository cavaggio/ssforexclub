/**
 * Classify H1 *active momentum* independently from the slower H1 structure
 * label. A structural bullish/bearish bias is not sufficient to authorize a
 * continuation when the most recent completed hourly candles are rotating the
 * other way or have already exhausted their impulse.
 */

const normalizeDirection = (value) => {
  const direction = String(value || '').toLowerCase();
  if (['bullish', 'buy', 'long'].includes(direction)) return 'bullish';
  if (['bearish', 'sell', 'short'].includes(direction)) return 'bearish';
  return null;
};

const finite = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const directionOf = (candle) => {
  const open = finite(candle?.open);
  const close = finite(candle?.close);
  if (open == null || close == null || open === close) return 'neutral';
  return close > open ? 'bullish' : 'bearish';
};

export function classifyIctH1Momentum({
  h1Candles = [],
  bias,
  transition = null,
  lookback = 3,
  minEfficiency = 0.18,
} = {}) {
  const wanted = normalizeDirection(bias);
  const completed = (Array.isArray(h1Candles) ? h1Candles : [])
    .filter((candle) => candle?.complete !== false)
    .filter((candle) => [candle?.open, candle?.high, candle?.low, candle?.close]
      .every((value) => finite(value) != null));
  const recent = completed.slice(-Math.max(2, Number(lookback) || 3));
  const latest = recent.at(-1) || null;
  const directions = recent.map(directionOf);
  const bullishBodies = directions.filter((value) => value === 'bullish').length;
  const bearishBodies = directions.filter((value) => value === 'bearish').length;
  const start = finite(recent[0]?.open);
  const finish = finite(latest?.close);
  const netMove = start != null && finish != null ? finish - start : null;
  const activeDirection = netMove == null || netMove === 0
    ? 'neutral'
    : netMove > 0 ? 'bullish' : 'bearish';
  const totalRange = recent.reduce((sum, candle) => {
    const high = finite(candle?.high);
    const low = finite(candle?.low);
    return sum + (high != null && low != null ? Math.max(0, high - low) : 0);
  }, 0);
  const efficiency = netMove != null && totalRange > 0 ? Math.abs(netMove) / totalRange : 0;
  const latestDirection = directionOf(latest);
  const alignedBodies = wanted === 'bullish' ? bullishBodies : wanted === 'bearish' ? bearishBodies : 0;
  const opposingBodies = wanted === 'bullish' ? bearishBodies : wanted === 'bearish' ? bullishBodies : 0;
  const transitionAligned = transition?.ready === true && normalizeDirection(transition?.bias) === wanted;
  const activeAligned = Boolean(
    wanted &&
    recent.length >= 2 &&
    activeDirection === wanted &&
    latestDirection === wanted &&
    alignedBodies >= Math.ceil(recent.length / 2) &&
    efficiency >= Math.max(0.05, Number(minEfficiency) || 0.18),
  );
  const exhausted = Boolean(
    wanted && recent.length >= 2 && !transitionAligned && (
      activeDirection !== wanted ||
      latestDirection !== wanted ||
      opposingBodies >= Math.ceil(recent.length / 2)
    ),
  );
  const aligned = transitionAligned || activeAligned;
  const phase = transitionAligned
    ? 'transition'
    : activeAligned ? 'impulse'
      : exhausted ? 'exhausted' : 'neutral';

  let reason;
  if (!wanted) reason = 'Daily/H4 direction is unavailable for H1 momentum confirmation.';
  else if (recent.length < 2) reason = 'At least two completed H1 candles are required to measure active momentum.';
  else if (transitionAligned) reason = `The live H1 transition is actively turning ${wanted} with the Daily/H4 direction.`;
  else if (activeAligned) reason = `Completed H1 momentum is actively ${wanted} with the Daily/H4 direction.`;
  else reason = `H1 structure may remain ${wanted}, but active momentum is ${activeDirection} and the latest completed H1 candle is ${latestDirection}; continuation is exhausted or directionally unconfirmed.`;

  return {
    aligned,
    activeAligned,
    transitionAligned,
    exhausted,
    phase,
    bias: wanted,
    activeDirection,
    latestDirection,
    completedCandles: recent.length,
    alignedBodies,
    opposingBodies,
    efficiency: +efficiency.toFixed(4),
    latestCompletedAt: latest?.time ?? null,
    reason,
  };
}
