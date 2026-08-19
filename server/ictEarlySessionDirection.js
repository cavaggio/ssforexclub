/**
 * Fixed New York early-session H1 directional context.
 *
 * The 01:00, 02:00 and 03:00 ET candles are treated as a session narrative
 * input, not as three independent hard confirmations. D1/H4 still own the
 * permitted trade direction and M5 still owns the executable trigger.
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

function candleDirection(candle) {
  const open = finite(candle?.open);
  const close = finite(candle?.close);
  if (open == null || close == null || open === close) return 'neutral';
  return close > open ? 'bullish' : 'bearish';
}

function nyParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const read = (type) => Number(parts.find((part) => part.type === type)?.value);
  const year = read('year');
  const month = read('month');
  const day = read('day');
  const hour = read('hour');
  if (![year, month, day, hour].every(Number.isFinite)) return null;
  return {
    dateKey: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    hour,
  };
}

export function classifyIctEarlySessionDirection({
  h1Candles = [],
  bias,
  now = new Date(),
  hours = [1, 2, 3],
} = {}) {
  const wanted = normalizeDirection(bias);
  const current = nyParts(now);
  const targetHours = new Set((Array.isArray(hours) ? hours : [1, 2, 3]).map(Number));
  const byHour = new Map();

  for (const candle of Array.isArray(h1Candles) ? h1Candles : []) {
    const stamp = nyParts(candle?.time);
    if (!stamp || stamp.dateKey !== current?.dateKey || !targetHours.has(stamp.hour)) continue;
    if ([candle?.open, candle?.high, candle?.low, candle?.close].some((value) => finite(value) == null)) continue;
    byHour.set(stamp.hour, {
      hourEt: stamp.hour,
      time: candle.time ?? null,
      complete: candle.complete !== false,
      direction: candleDirection(candle),
      open: finite(candle.open),
      close: finite(candle.close),
      high: finite(candle.high),
      low: finite(candle.low),
    });
  }

  const samples = [...byHour.values()].sort((a, b) => a.hourEt - b.hourEt);
  const completed = samples.filter((sample) => sample.complete);
  // Prefer completed candles. Before two of the fixed candles have closed, retain
  // the available live candle as provisional narrative rather than pretending the
  // 01:00-03:00 profile is complete.
  const directional = completed.length >= 2 ? completed : samples;
  const bullishCount = directional.filter((sample) => sample.direction === 'bullish').length;
  const bearishCount = directional.filter((sample) => sample.direction === 'bearish').length;
  const firstOpen = directional.length ? directional[0].open : null;
  const lastClose = directional.length ? directional.at(-1).close : null;
  const netDirection = firstOpen == null || lastClose == null || firstOpen === lastClose
    ? 'neutral'
    : lastClose > firstOpen ? 'bullish' : 'bearish';

  let direction = 'neutral';
  if (bullishCount > bearishCount) direction = 'bullish';
  else if (bearishCount > bullishCount) direction = 'bearish';
  else if (directional.length) direction = netDirection;

  const directionalBodies = bullishCount + bearishCount;
  const agreementRatio = directionalBodies > 0
    ? Math.max(bullishCount, bearishCount) / directionalBodies
    : 0;
  const provisional = completed.length < 2;
  const alignedWithBias = Boolean(wanted && direction !== 'neutral' && direction === wanted);
  const opposesBias = Boolean(wanted && direction !== 'neutral' && direction !== wanted);
  const confidence = Math.round(Math.max(0, Math.min(100,
    (Math.min(3, completed.length) / 3) * 55 + agreementRatio * 45,
  )));

  return {
    dateKey: current?.dateKey ?? null,
    hoursEt: [1, 2, 3],
    samples,
    availableCount: samples.length,
    completedCount: completed.length,
    provisional,
    direction,
    netDirection,
    bullishCount,
    bearishCount,
    agreementRatio: +agreementRatio.toFixed(3),
    confidence,
    bias: wanted,
    alignedWithBias,
    opposesBias,
    rule: '01:00/02:00/03:00_ET_session_direction_context',
    reason: !samples.length
      ? 'No 01:00-03:00 ET H1 candles are available yet for the current New York trading day.'
      : `${completed.length}/3 fixed early-session H1 candles are complete; session direction is ${direction}${wanted ? ` versus ${wanted} D1/H4 bias` : ''}.`,
  };
}
