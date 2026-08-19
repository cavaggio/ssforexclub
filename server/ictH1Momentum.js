/**
 * Classify H1 *active momentum* independently from the slower H1 structure
 * label. The current/live H1 impulse is allowed to confirm a continuation even
 * when older completed candles were part of the consolidation that preceded the
 * breakout. A strong live move in the opposite direction still vetoes entry.
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

const bodyEfficiency = (candle) => {
  const open = finite(candle?.open);
  const close = finite(candle?.close);
  const high = finite(candle?.high);
  const low = finite(candle?.low);
  if ([open, close, high, low].some((value) => value == null) || high <= low) return 0;
  return Math.abs(close - open) / Math.max(1e-12, high - low);
};

export function classifyIctH1Momentum({
  h1Candles = [],
  bias,
  transition = null,
  lookback = 3,
  minEfficiency = 0.18,
  minCurrentBodyEfficiency = 0.20,
  opposingCurrentBodyEfficiency = 0.35,
} = {}) {
  const wanted = normalizeDirection(bias);
  const all = (Array.isArray(h1Candles) ? h1Candles : [])
    .filter((candle) => [candle?.open, candle?.high, candle?.low, candle?.close]
      .every((value) => finite(value) != null));
  const completed = all.filter((candle) => candle?.complete !== false);
  const recent = completed.slice(-Math.max(2, Number(lookback) || 3));
  const latest = recent.at(-1) || null;
  const live = all.at(-1)?.complete === false ? all.at(-1) : null;
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
  const currentDirection = directionOf(live);
  const currentBodyEfficiency = bodyEfficiency(live);
  const alignedBodies = wanted === 'bullish' ? bullishBodies : wanted === 'bearish' ? bearishBodies : 0;
  const opposingBodies = wanted === 'bullish' ? bearishBodies : wanted === 'bearish' ? bullishBodies : 0;
  const transitionAligned = transition?.ready === true && normalizeDirection(transition?.bias) === wanted;

  // Efficiency remains useful diagnostics, but it is not a hard directional veto.
  // If the net completed H1 move and latest completed H1 candle agree with D1/H4,
  // the continuation is directionally confirmed even after choppy consolidation.
  const completedImpulseAligned = Boolean(
    wanted &&
    recent.length >= 2 &&
    activeDirection === wanted &&
    latestDirection === wanted,
  );
  const currentAligned = Boolean(
    wanted && live && currentDirection === wanted &&
    currentBodyEfficiency >= Math.max(0.10, Number(minCurrentBodyEfficiency) || 0.20),
  );
  const currentOpposing = Boolean(
    wanted && live && currentDirection !== 'neutral' && currentDirection !== wanted &&
    currentBodyEfficiency >= Math.max(0.20, Number(opposingCurrentBodyEfficiency) || 0.35),
  );
  const activeAligned = completedImpulseAligned || currentAligned;
  const aligned = !currentOpposing && (transitionAligned || activeAligned);

  // Do not call a new impulse "exhausted" merely because older candles in the
  // lookback were countertrend or inefficient. Exhaustion requires genuinely
  // opposing current action or both net + latest completed H1 to oppose D1/H4.
  const exhausted = Boolean(
    wanted && recent.length >= 2 && !transitionAligned && !currentAligned && (
      currentOpposing ||
      (activeDirection !== wanted && latestDirection !== wanted)
    ),
  );
  const phase = transitionAligned
    ? 'transition'
    : currentAligned ? 'live_impulse'
      : completedImpulseAligned ? 'impulse'
        : exhausted ? 'exhausted' : 'neutral';

  let reason;
  if (!wanted) reason = 'Daily/H4 direction is unavailable for H1 momentum confirmation.';
  else if (recent.length < 2) reason = 'At least two completed H1 candles are required to measure active momentum.';
  else if (currentOpposing) reason = `The live H1 candle is actively ${currentDirection} against the ${wanted} Daily/H4 direction.`;
  else if (transitionAligned) reason = `The live H1 transition is actively turning ${wanted} with the Daily/H4 direction.`;
  else if (currentAligned) reason = `The live H1 candle is actively ${wanted} with the Daily/H4 direction; older consolidation candles do not veto the new impulse.`;
  else if (completedImpulseAligned) reason = `Completed H1 momentum is actively ${wanted} with the Daily/H4 direction; efficiency ${efficiency.toFixed(3)} is diagnostic only.`;
  else reason = `H1 structure may remain ${wanted}, but active completed momentum is ${activeDirection} and the latest completed H1 candle is ${latestDirection}; continuation is not yet directionally confirmed.`;

  return {
    aligned,
    activeAligned,
    completedImpulseAligned,
    currentAligned,
    currentOpposing,
    transitionAligned,
    exhausted,
    phase,
    bias: wanted,
    activeDirection,
    latestDirection,
    currentDirection,
    currentBodyEfficiency: +currentBodyEfficiency.toFixed(4),
    completedCandles: recent.length,
    alignedBodies,
    opposingBodies,
    efficiency: +efficiency.toFixed(4),
    efficiencyFloor: Math.max(0.05, Number(minEfficiency) || 0.18),
    efficiencyInformationalOnly: true,
    latestCompletedAt: latest?.time ?? null,
    liveCandleAt: live?.time ?? null,
    reason,
  };
}
