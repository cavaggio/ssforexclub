import { getCandles, getPricing } from './oandaMarketData.js';
import { atr, ema } from './oandaIndicators.js';
import { etParts } from './ictTime.js';

/**
 * PPR (Price–Pool–Raid) engine.
 *
 * Isolation contract:
 * - Reads raw OANDA pricing and candles directly.
 * - Does not import or consume legacy, V3, or ICT scanners, scores, signals,
 *   watch registries, confirmations, or execution decisions.
 * - Produces its own EMA9 bias/alignment, liquidity target clusters,
 *   session/tick-volume filter, misdirection evidence, stop, target and R:R.
 */

const PPR_ALLOWED_WATCHLIST = Object.freeze(['GBP_JPY', 'EUR_GBP', 'GBP_USD']);
const ACCEPTED_MANIPULATION_TYPES = new Set([
  'liquidity_raid',
  'fvg_mitigation',
  'order_block_retest',
]);

const numberEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};

export function pprConfig() {
  return {
    dailyEma: Math.max(2, Math.floor(numberEnv('PPR_DAILY_EMA', 9))),
    h1Ema: Math.max(2, Math.floor(numberEnv('PPR_H1_EMA', 9))),
    minConfidence: Math.max(0, Math.min(100, numberEnv('PPR_MIN_CONFIDENCE', 85))),
    minRR: Math.max(1.5, numberEnv('PPR_MIN_RR', 1.5)),
    volumeLookback: Math.max(5, Math.floor(numberEnv('PPR_VOLUME_LOOKBACK', 20))),
    volumeSpikeMultiplier: Math.max(1, numberEnv('PPR_VOLUME_SPIKE_MULTIPLIER', 1.5)),
    swingLookback: Math.max(1, Math.floor(numberEnv('PPR_SWING_LOOKBACK', 2))),
    stopBufferAtr: Math.max(0.05, numberEnv('PPR_STOP_BUFFER_ATR', 0.15)),
    maxEntryDistancePips: Math.max(1, numberEnv('PPR_MAX_ENTRY_DISTANCE_PIPS', 12)),
    poolClusterTolerancePips: Math.max(0.5, numberEnv('PPR_POOL_CLUSTER_TOLERANCE_PIPS', 2)),
    maxSpreadPips: Math.max(0.1, numberEnv('PPR_MAX_SPREAD_PIPS', numberEnv('FOREX_MAX_SPREAD_PIPS', 5))),
  };
}

export function getPprWatchlist() {
  const requested = String(process.env.PPR_FOREX_WATCHLIST || '')
    .split(',')
    .map((pair) => pair.trim().toUpperCase())
    .filter(Boolean);
  if (!requested.length) return [...PPR_ALLOWED_WATCHLIST];
  const allowed = requested.filter((pair) => PPR_ALLOWED_WATCHLIST.includes(pair));
  return allowed.length ? [...new Set(allowed)] : [...PPR_ALLOWED_WATCHLIST];
}

export function pprPipSize(pair) {
  if (String(pair).includes('JPY')) return 0.01;
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return 0.01;
  return 0.0001;
}

function priceDecimals(pair) {
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return 2;
  return String(pair).includes('JPY') ? 3 : 5;
}

function roundPrice(value, pair) {
  return Number(Number(value).toFixed(priceDecimals(pair)));
}

function average(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function finiteCandle(candle) {
  if (!candle || typeof candle !== 'object') return null;
  const open = Number(candle.open);
  const high = Number(candle.high);
  const low = Number(candle.low);
  const close = Number(candle.close);
  if (![open, high, low, close].every(Number.isFinite) || high < low) return null;
  return { ...candle, open, high, low, close, volume: Number(candle.volume ?? 0) };
}

function validCandles(candles) {
  return Array.isArray(candles) ? candles.map(finiteCandle).filter(Boolean) : [];
}

function candleDirection(candle) {
  if (!candle) return 'neutral';
  if (candle.close > candle.open) return 'bullish';
  if (candle.close < candle.open) return 'bearish';
  return 'neutral';
}

function emaState(candles, period) {
  const closes = validCandles(candles).map((candle) => candle.close);
  const required = period + 5;
  if (closes.length < required) {
    return { ready: false, price: null, ema: null, slope: null, required, count: closes.length };
  }
  const current = ema(closes, period);
  const prior = ema(closes.slice(0, -3), period);
  const price = closes.at(-1);
  return {
    ready: [current, prior, price].every(Number.isFinite),
    price,
    ema: current,
    slope: Number(current) - Number(prior),
    required,
    count: closes.length,
  };
}

export function classifyPprDailyBias(candles, config = pprConfig()) {
  const state = emaState(candles, config.dailyEma);
  if (!state.ready) {
    return {
      bias: 'neutral',
      reason: `Daily EMA${config.dailyEma} data unavailable (${state.count}/${state.required})`,
      ema: state.ema,
      slope: state.slope,
      price: state.price,
    };
  }
  if (state.price > state.ema && state.slope > 0) {
    return {
      bias: 'bullish',
      reason: `Daily close is above a rising EMA${config.dailyEma}`,
      ema: state.ema,
      slope: state.slope,
      price: state.price,
    };
  }
  if (state.price < state.ema && state.slope < 0) {
    return {
      bias: 'bearish',
      reason: `Daily close is below a falling EMA${config.dailyEma}`,
      ema: state.ema,
      slope: state.slope,
      price: state.price,
    };
  }
  return {
    bias: 'neutral',
    reason: `Daily price and EMA${config.dailyEma} slope do not establish one direction`,
    ema: state.ema,
    slope: state.slope,
    price: state.price,
  };
}

export function classifyPprH1Alignment(candles, direction, config = pprConfig()) {
  const state = emaState(candles, config.h1Ema);
  if (!state.ready) {
    return {
      aligned: false,
      direction,
      reason: `H1 EMA${config.h1Ema} data unavailable (${state.count}/${state.required})`,
      ema: state.ema,
      slope: state.slope,
      price: state.price,
    };
  }
  const aligned = direction === 'long'
    ? state.price > state.ema
    : direction === 'short'
      ? state.price < state.ema
      : false;
  return {
    aligned,
    direction,
    reason: aligned
      ? `H1 close is ${direction === 'long' ? 'above' : 'below'} EMA${config.h1Ema}`
      : `H1 close is not ${direction === 'long' ? 'above' : 'below'} EMA${config.h1Ema}`,
    ema: state.ema,
    slope: state.slope,
    price: state.price,
  };
}

export function findPprSwingPools(candles, lookback = 2, timeframe = 'H1') {
  const source = validCandles(candles);
  const highs = [];
  const lows = [];
  if (source.length < lookback * 2 + 1) return { highs, lows };

  for (let index = lookback; index < source.length - lookback; index += 1) {
    const candle = source[index];
    let swingHigh = true;
    let swingLow = true;
    for (let cursor = index - lookback; cursor <= index + lookback; cursor += 1) {
      if (cursor === index) continue;
      if (source[cursor].high >= candle.high) swingHigh = false;
      if (source[cursor].low <= candle.low) swingLow = false;
    }
    if (swingHigh) highs.push({
      side: 'high',
      price: candle.high,
      time: candle.time,
      index,
      source: `${String(timeframe).toLowerCase()}_swing_high`,
      timeframe,
      touches: 1,
    });
    if (swingLow) lows.push({
      side: 'low',
      price: candle.low,
      time: candle.time,
      index,
      source: `${String(timeframe).toLowerCase()}_swing_low`,
      timeframe,
      touches: 1,
    });
  }
  return { highs, lows };
}

function nyClock(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(date);
  const read = (type) => parts.find((part) => part.type === type)?.value ?? '';
  const year = Number(read('year'));
  const month = Number(read('month'));
  const day = Number(read('day'));
  const hour = Number(read('hour')) % 24;
  const minute = Number(read('minute'));
  if (![year, month, day, hour, minute].every(Number.isFinite)) return null;
  const daySerial = Date.UTC(year, month - 1, day) / 60000;
  return {
    year,
    month,
    day,
    weekday: read('weekday'),
    dateKey: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    minutes: hour * 60 + minute,
    daySerial,
    serial: daySerial + hour * 60 + minute,
  };
}

function mondayKey(clock) {
  if (!clock) return null;
  const date = new Date(clock.daySerial * 60000);
  const day = date.getUTCDay();
  const offset = day === 0 ? 6 : day - 1;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

function addRangeLevels(levels, candles, { source, timeframe, startSerial = -Infinity, endSerial = Infinity } = {}) {
  const rows = validCandles(candles)
    .map((candle) => ({ candle, clock: nyClock(candle.time) }))
    .filter(({ clock }) => clock && clock.serial >= startSerial && clock.serial < endSerial);
  if (!rows.length) return;
  const highRow = rows.reduce((best, row) => row.candle.high > best.candle.high ? row : best);
  const lowRow = rows.reduce((best, row) => row.candle.low < best.candle.low ? row : best);
  levels.push({
    side: 'high',
    price: highRow.candle.high,
    time: highRow.candle.time,
    source: `${source}_high`,
    timeframe,
    touches: 1,
  });
  levels.push({
    side: 'low',
    price: lowRow.candle.low,
    time: lowRow.candle.time,
    source: `${source}_low`,
    timeframe,
    touches: 1,
  });
}

function previousDayLevels(levels, h1, nowClock) {
  const grouped = new Map();
  for (const candle of validCandles(h1)) {
    const clock = nyClock(candle.time);
    if (!clock || clock.dateKey >= nowClock.dateKey) continue;
    if (!grouped.has(clock.dateKey)) grouped.set(clock.dateKey, []);
    grouped.get(clock.dateKey).push(candle);
  }
  const key = [...grouped.keys()].sort().at(-1);
  if (!key) return;
  addRangeLevels(levels, grouped.get(key), {
    source: 'previous_day',
    timeframe: 'H1',
  });
}

function previousWeekLevels(levels, daily, nowClock) {
  const currentWeek = mondayKey(nowClock);
  const grouped = new Map();
  for (const candle of validCandles(daily)) {
    const clock = nyClock(candle.time);
    const key = mondayKey(clock);
    if (!clock || !key || key >= currentWeek) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(candle);
  }
  const key = [...grouped.keys()].sort().at(-1);
  if (!key) return;
  addRangeLevels(levels, grouped.get(key), {
    source: 'previous_week',
    timeframe: 'D',
  });
}

function sessionLevels(levels, m15, nowClock) {
  const dayStart = nowClock.daySerial;
  const ranges = [
    { source: 'asian_session', start: dayStart - 240, end: dayStart + 120 },
    { source: 'london_session', start: dayStart + 120, end: Math.min(nowClock.serial, dayStart + 420) },
    { source: 'new_york_am_session', start: dayStart + 420, end: Math.min(nowClock.serial, dayStart + 600) },
  ];
  for (const range of ranges) {
    if (range.end <= range.start) continue;
    addRangeLevels(levels, m15, {
      source: range.source,
      timeframe: 'M15',
      startSerial: range.start,
      endSerial: range.end,
    });
  }
}

function clusterSideLevels(levels, pair, side, tolerancePips) {
  const tolerance = pprPipSize(pair) * tolerancePips;
  const sorted = levels
    .filter((level) => level.side === side && Number.isFinite(Number(level.price)))
    .sort((a, b) => a.price - b.price);
  const groups = [];
  for (const level of sorted) {
    const group = groups.at(-1);
    const center = group ? average(group.map((item) => item.price)) : null;
    if (!group || Math.abs(level.price - center) > tolerance) groups.push([level]);
    else group.push(level);
  }
  return groups.map((group) => {
    const sources = [...new Set(group.map((item) => item.source).filter(Boolean))];
    const timeframes = [...new Set(group.map((item) => item.timeframe).filter(Boolean))];
    const touches = group.reduce((sum, item) => sum + Math.max(1, Number(item.touches) || 1), 0);
    const equalSource = side === 'high' ? 'equal_highs' : 'equal_lows';
    if (touches >= 2 && !sources.includes(equalSource)) sources.push(equalSource);
    const price = average(group.map((item) => item.price));
    return {
      side,
      price: roundPrice(price, pair),
      type: 'liquidity_cluster',
      sources,
      timeframes,
      touchCount: touches,
      overlapping: sources.length > 1 || touches > 1,
      confluenceScore: sources.length + Math.min(3, Math.max(0, touches - 1)),
      componentLevels: group,
      time: group.map((item) => item.time).filter(Boolean).sort().at(-1) || null,
    };
  });
}

export function buildPprLiquidityPools({
  pair,
  daily = [],
  h1 = [],
  m15 = [],
  now = new Date(),
  config = pprConfig(),
} = {}) {
  const nowClock = nyClock(now);
  const h1Swings = findPprSwingPools(h1, config.swingLookback, 'H1');
  const m15Swings = findPprSwingPools(m15, config.swingLookback, 'M15');
  const levels = [
    ...h1Swings.highs,
    ...h1Swings.lows,
    ...m15Swings.highs,
    ...m15Swings.lows,
  ];
  if (nowClock) {
    previousDayLevels(levels, h1, nowClock);
    previousWeekLevels(levels, daily, nowClock);
    sessionLevels(levels, m15, nowClock);
  }
  return {
    highs: clusterSideLevels(levels, pair, 'high', config.poolClusterTolerancePips),
    lows: clusterSideLevels(levels, pair, 'low', config.poolClusterTolerancePips),
    rawLevels: levels,
    sourcesIncluded: [...new Set(levels.map((level) => level.source))],
    selectionPolicy: 'source_neutral_nearest_executable_cluster_with_minimum_rr',
  };
}

export function selectPprLiquidityTarget({
  pools,
  direction,
  entry,
  stopLoss = null,
  minRR = 1.5,
} = {}) {
  const source = direction === 'long' ? pools?.highs : pools?.lows;
  const valid = (Array.isArray(source) ? source : [])
    .filter((pool) => Number.isFinite(Number(pool.price)))
    .filter((pool) => direction === 'long' ? pool.price > entry : pool.price < entry)
    .map((pool) => {
      const risk = Number.isFinite(Number(stopLoss))
        ? Math.abs(entry - Number(stopLoss))
        : null;
      const reward = Math.abs(Number(pool.price) - entry);
      const rr = risk > 0 ? reward / risk : null;
      return { ...pool, rr };
    })
    .filter((pool) => !Number.isFinite(Number(stopLoss)) || (Number.isFinite(pool.rr) && pool.rr >= minRR))
    .sort((a, b) => {
      const distance = Math.abs(a.price - entry) - Math.abs(b.price - entry);
      if (Math.abs(distance) > Number.EPSILON) return distance;
      return Number(b.confluenceScore || 0) - Number(a.confluenceScore || 0);
    });
  const target = valid[0] || null;
  if (!target) return null;
  return {
    ...target,
    type: 'liquidity_cluster',
    targetSide: direction === 'long' ? 'buy_side_liquidity' : 'sell_side_liquidity',
    selectionReason: 'Nearest source-neutral liquidity cluster that preserves executable minimum R:R',
  };
}

export function detectPprVolumeSpike(candles, config = pprConfig()) {
  const source = validCandles(candles);
  if (source.length < config.volumeLookback + 1) {
    return {
      detected: false,
      ratio: null,
      currentVolume: null,
      averageVolume: null,
      reason: 'Insufficient M5 tick-volume history',
    };
  }
  const last = source.at(-1);
  const baseline = source.slice(-(config.volumeLookback + 1), -1);
  const averageVolume = average(baseline.map((candle) => candle.volume));
  const currentVolume = Number(last?.volume);
  const ratio = averageVolume > 0 && Number.isFinite(currentVolume) ? currentVolume / averageVolume : null;
  const detected = Number.isFinite(ratio) && ratio >= config.volumeSpikeMultiplier;
  return {
    detected,
    ratio,
    currentVolume,
    averageVolume,
    reason: detected
      ? `M5 tick volume is ${ratio.toFixed(2)}x its ${config.volumeLookback}-bar average`
      : `M5 tick volume has not reached ${config.volumeSpikeMultiplier.toFixed(2)}x average`,
  };
}

function componentDistancePips(component, entry, pair) {
  const reference = Number(
    component.entryReferencePrice ??
    component.level ??
    (
      Number.isFinite(Number(component.zoneLow)) && Number.isFinite(Number(component.zoneHigh))
        ? (Number(component.zoneLow) + Number(component.zoneHigh)) / 2
        : component.triggerPrice
    ),
  );
  return Number.isFinite(reference)
    ? Math.abs(Number(entry) - reference) / pprPipSize(pair)
    : null;
}

export function detectPprLiquidityRaid({
  candles,
  pools,
  direction,
  pair = 'EUR_USD',
  currentEntry = null,
} = {}) {
  const source = validCandles(candles);
  if (source.length < 3) return null;
  const references = direction === 'long' ? pools?.lows : pools?.highs;
  const candidates = [];

  for (const reference of Array.isArray(references) ? references : []) {
    const level = Number(reference.price);
    if (!Number.isFinite(level)) continue;
    for (let index = 0; index < source.length; index += 1) {
      const trigger = source[index];
      const swept = direction === 'long'
        ? trigger.low < level && trigger.close > level
        : trigger.high > level && trigger.close < level;
      if (!swept) continue;
      const invalidation = direction === 'long' ? trigger.low : trigger.high;
      const after = source.slice(index + 1);
      const invalidated = direction === 'long'
        ? after.some((candle) => candle.close < level || candle.low < invalidation)
        : after.some((candle) => candle.close > level || candle.high > invalidation);
      if (invalidated) continue;
      candidates.push({
        type: 'liquidity_raid',
        subtype: direction === 'long' ? 'sell_side_stop_hunt' : 'buy_side_stop_hunt',
        direction: direction === 'long' ? 'bullish' : 'bearish',
        level,
        invalidation,
        entryReferencePrice: level,
        triggerPrice: trigger.close,
        triggerTime: trigger.time,
        triggerIndex: index,
        retest: index < source.length - 1,
        sourcePool: reference,
        reason: direction === 'long'
          ? 'Sell-side liquidity was raided, reclaimed, and remains valid for an aligned retest'
          : 'Buy-side liquidity was raided, reclaimed, and remains valid for an aligned retest',
      });
    }
  }

  const latest = candidates.sort((a, b) => b.triggerIndex - a.triggerIndex)[0] || null;
  if (!latest) return null;
  const entry = Number.isFinite(Number(currentEntry)) ? Number(currentEntry) : source.at(-1).close;
  return { ...latest, distancePips: componentDistancePips(latest, entry, pair) };
}

export function detectPprFvgMitigation({
  candles,
  direction,
  pair = 'EUR_USD',
  currentEntry = null,
} = {}) {
  const source = validCandles(candles);
  if (source.length < 8) return null;
  const last = source.at(-1);
  const candidates = [];

  for (let index = 2; index < source.length - 1; index += 1) {
    const first = source[index - 2];
    const third = source[index];
    if (direction === 'long' && first.high < third.low) {
      const lower = first.high;
      const upper = third.low;
      const invalidated = source.slice(index + 1, -1).some((candle) => candle.close < lower);
      const overlaps = last.low <= upper && last.high >= lower;
      if (!invalidated && overlaps && last.close > (lower + upper) / 2 && candleDirection(last) === 'bullish') {
        candidates.push({
          type: 'fvg_mitigation',
          subtype: 'bullish_fvg',
          direction: 'bullish',
          zoneLow: lower,
          zoneHigh: upper,
          invalidation: lower,
          entryReferencePrice: (lower + upper) / 2,
          triggerTime: last.time,
          formationTime: third.time,
          formationIndex: index,
          reason: 'Bullish FVG was mitigated and rejected upward',
        });
      }
    }
    if (direction === 'short' && first.low > third.high) {
      const lower = third.high;
      const upper = first.low;
      const invalidated = source.slice(index + 1, -1).some((candle) => candle.close > upper);
      const overlaps = last.high >= lower && last.low <= upper;
      if (!invalidated && overlaps && last.close < (lower + upper) / 2 && candleDirection(last) === 'bearish') {
        candidates.push({
          type: 'fvg_mitigation',
          subtype: 'bearish_fvg',
          direction: 'bearish',
          zoneLow: lower,
          zoneHigh: upper,
          invalidation: upper,
          entryReferencePrice: (lower + upper) / 2,
          triggerTime: last.time,
          formationTime: third.time,
          formationIndex: index,
          reason: 'Bearish FVG was mitigated and rejected downward',
        });
      }
    }
  }

  const latest = candidates.sort((a, b) => b.formationIndex - a.formationIndex)[0] || null;
  if (!latest) return null;
  const entry = Number.isFinite(Number(currentEntry)) ? Number(currentEntry) : last.close;
  return { ...latest, distancePips: componentDistancePips(latest, entry, pair) };
}

export function detectPprOrderBlockRetest({
  candles,
  direction,
  atrValue,
  pair = 'EUR_USD',
  currentEntry = null,
} = {}) {
  const source = validCandles(candles);
  if (source.length < 10 || !Number.isFinite(atrValue)) return null;
  const last = source.at(-1);
  const candidates = [];

  for (let index = 1; index < source.length - 1; index += 1) {
    const displacement = source[index];
    const origin = source[index - 1];
    const body = Math.abs(displacement.close - displacement.open);
    const alignedDisplacement = direction === 'long'
      ? displacement.close > displacement.open && origin.close < origin.open
      : displacement.close < displacement.open && origin.close > origin.open;
    if (!alignedDisplacement || body < atrValue * 1.2) continue;

    const zoneLow = Math.min(origin.open, origin.close, origin.low);
    const zoneHigh = Math.max(origin.open, origin.close, origin.high);
    const invalidated = direction === 'long'
      ? source.slice(index + 1, -1).some((candle) => candle.close < zoneLow)
      : source.slice(index + 1, -1).some((candle) => candle.close > zoneHigh);
    const touched = last.low <= zoneHigh && last.high >= zoneLow;
    const rejected = direction === 'long'
      ? candleDirection(last) === 'bullish' && last.close > origin.open
      : candleDirection(last) === 'bearish' && last.close < origin.open;
    if (!invalidated && touched && rejected) {
      candidates.push({
        type: 'order_block_retest',
        subtype: direction === 'long' ? 'bullish_order_block' : 'bearish_order_block',
        direction: direction === 'long' ? 'bullish' : 'bearish',
        zoneLow,
        zoneHigh,
        invalidation: direction === 'long' ? zoneLow : zoneHigh,
        entryReferencePrice: (zoneLow + zoneHigh) / 2,
        triggerTime: last.time,
        formationTime: origin.time,
        formationIndex: index,
        reason: 'Price mitigated the opposing candle before displacement and rejected with the EMA bias',
      });
    }
  }

  const latest = candidates.sort((a, b) => b.formationIndex - a.formationIndex)[0] || null;
  if (!latest) return null;
  const entry = Number.isFinite(Number(currentEntry)) ? Number(currentEntry) : last.close;
  return { ...latest, distancePips: componentDistancePips(latest, entry, pair) };
}

export function combinePprManipulations(components, direction) {
  const valid = (Array.isArray(components) ? components : [])
    .filter((component) => component && ACCEPTED_MANIPULATION_TYPES.has(component.type));
  if (!valid.length) return null;
  const invalidations = valid.map((component) => Number(component.invalidation)).filter(Number.isFinite);
  const invalidation = direction === 'long'
    ? Math.min(...invalidations)
    : Math.max(...invalidations);
  const distances = valid.map((component) => Number(component.distancePips)).filter(Number.isFinite);
  return {
    type: valid.length > 1 ? 'composite_misdirection' : valid[0].type,
    types: valid.map((component) => component.type),
    subtypes: valid.map((component) => component.subtype).filter(Boolean),
    direction: direction === 'long' ? 'bullish' : 'bearish',
    invalidation,
    entryReferencePrice: valid.sort((a, b) => Number(a.distancePips ?? Infinity) - Number(b.distancePips ?? Infinity))[0]?.entryReferencePrice ?? null,
    distancePips: distances.length ? Math.min(...distances) : null,
    triggerTime: valid.map((component) => component.triggerTime).filter(Boolean).sort().at(-1) || null,
    components: valid,
    reason: valid.length > 1
      ? `Composite PPR misdirection confirmed: ${valid.map((component) => component.type).join(' + ')}`
      : valid[0].reason,
  };
}

export function pprSession(now = new Date()) {
  const et = etParts(now);
  if (!et || et.isWeekend) {
    return { allowed: false, name: 'closed', minutes: null, reason: 'PPR runs Monday through Friday only' };
  }
  const minutes = et.minutesFromMidnight;
  if (minutes < 120 || minutes >= 600) {
    return { allowed: false, name: 'closed', minutes, reason: 'Outside the 02:00–10:00 ET PPR entry window' };
  }
  const name = minutes < 300 ? 'London' : minutes < 420 ? 'London_to_New_York' : 'New_York_AM';
  return { allowed: true, name, minutes, reason: `${name.replaceAll('_', ' ')} PPR session` };
}

function executableEntry(pricing, direction) {
  return direction === 'long' ? Number(pricing?.ask) : Number(pricing?.bid);
}

function lifecycleFor({ pair, entry, stopLoss, takeProfit, atrPips }) {
  const pipSize = pprPipSize(pair);
  const stopLossPips = Math.abs(entry - stopLoss) / pipSize;
  const takeProfitPips = Math.abs(takeProfit - entry) / pipSize;
  return {
    allowed: true,
    source: 'ppr_native_geometry',
    sl: { stopLossPips, stopLossPrice: stopLoss },
    tp: { allowed: true, takeProfitPips, takeProfitPrice: takeProfit },
    management: {
      automatedManagement: false,
      beforeCutoff: 'broker_attached_sl_tp_only',
      cutoffEt: '10:00',
      afterCutoff: 'manual_only',
      breakeven: 'disabled',
      partialExits: 'disabled',
      trailingStop: 'disabled',
      earlyInvalidationExit: 'disabled',
      timeBasedExit: 'manual',
    },
    hold: {
      style: 'intraday',
      automatedExit: false,
      managementCutoffEt: '10:00',
      afterCutoff: 'manual_only',
    },
    atrPips,
  };
}

export async function analyzePprPair({ pair, client, now = new Date(), config = pprConfig() }) {
  const normalizedPair = String(pair || '').trim().toUpperCase();
  const session = pprSession(now);
  const resultBase = {
    pair: normalizedPair,
    engine: 'ppr',
    strategy: 'PPR',
    source: 'ppr_auto_ai',
    architecture: 'independent_ppr_raw_market_data',
    legacyScannerUsed: false,
    v3LogicUsed: false,
    ictLogicUsed: false,
    newsPolicy: {
      configured: false,
      inherited: false,
      blocked: false,
      mode: 'ppr_news_policy_not_defined',
    },
    session,
  };

  if (!PPR_ALLOWED_WATCHLIST.includes(normalizedPair)) {
    return {
      status: 'rejected',
      reason: `PPR pair ${normalizedPair || 'missing'} is outside the fixed GBP_JPY, EUR_GBP, GBP_USD watchlist`,
      ...resultBase,
    };
  }
  if (!session.allowed) return { status: 'rejected', reason: session.reason, ...resultBase };

  const [daily, h1, m15, m5, pricingRows] = await Promise.all([
    getCandles(normalizedPair, 'D', 120, { client }),
    getCandles(normalizedPair, 'H1', 220, { client }),
    getCandles(normalizedPair, 'M15', 240, { client }),
    getCandles(normalizedPair, 'M5', 240, { client }),
    getPricing([normalizedPair], { client }),
  ]);
  const pricing = Array.isArray(pricingRows)
    ? pricingRows.find((row) => row.instrument === normalizedPair)
    : null;
  if (!pricing || pricing.tradeable === false) {
    return { status: 'rejected', reason: 'No tradeable executable OANDA quote', ...resultBase };
  }
  if (Number(pricing.spreadPips) > config.maxSpreadPips) {
    return {
      status: 'rejected',
      reason: `Spread ${pricing.spreadPips}p exceeds PPR cap ${config.maxSpreadPips}p`,
      ...resultBase,
      pricing,
    };
  }

  const bias = classifyPprDailyBias(daily, config);
  if (bias.bias === 'neutral') {
    return { status: 'near', reason: bias.reason, ...resultBase, pricing, dailyBias: bias };
  }

  const direction = bias.bias === 'bullish' ? 'long' : 'short';
  const h1Alignment = classifyPprH1Alignment(h1, direction, config);
  if (!h1Alignment.aligned) {
    return {
      status: 'near',
      reason: h1Alignment.reason,
      ...resultBase,
      pricing,
      dailyBias: bias,
      h1Alignment,
      direction,
    };
  }

  const entry = executableEntry(pricing, direction);
  if (!Number.isFinite(entry) || entry <= 0) {
    return {
      status: 'rejected',
      reason: 'Executable bid/ask is invalid',
      ...resultBase,
      pricing,
      dailyBias: bias,
      h1Alignment,
    };
  }

  const atrValue = atr(m5, 14);
  const atrPips = Number.isFinite(atrValue) ? atrValue / pprPipSize(normalizedPair) : null;
  if (!Number.isFinite(atrValue) || atrValue <= 0) {
    return {
      status: 'near',
      reason: 'M5 ATR is unavailable for PPR geometry',
      ...resultBase,
      pricing,
      dailyBias: bias,
      h1Alignment,
      direction,
    };
  }

  const liquidityPools = buildPprLiquidityPools({
    pair: normalizedPair,
    daily,
    h1,
    m15,
    now,
    config,
  });
  const m15SwingPools = findPprSwingPools(m15, config.swingLookback, 'M15');
  const volume = detectPprVolumeSpike(m5, config);
  const raid = detectPprLiquidityRaid({
    candles: m5,
    pools: m15SwingPools,
    direction,
    pair: normalizedPair,
    currentEntry: entry,
  });
  const fvg = detectPprFvgMitigation({
    candles: m5,
    direction,
    pair: normalizedPair,
    currentEntry: entry,
  });
  const orderBlock = detectPprOrderBlockRetest({
    candles: m5,
    direction,
    atrValue,
    pair: normalizedPair,
    currentEntry: entry,
  });
  const rawManipulations = [raid, fvg, orderBlock].filter(Boolean);
  const freshManipulations = rawManipulations.filter(
    (component) => Number.isFinite(Number(component.distancePips)) &&
      Number(component.distancePips) <= config.maxEntryDistancePips,
  );
  const manipulation = combinePprManipulations(freshManipulations, direction);
  const confirmation = candleDirection(validCandles(m5).at(-1));
  const alignedConfirmation = confirmation === bias.bias;

  const evidence = {
    dailyBias: bias,
    h1Alignment,
    liquidityPools,
    volume,
    manipulation,
    manipulationCandidates: rawManipulations,
    alternatives: {
      liquidityRaid: raid,
      fvgMitigation: fvg,
      orderBlockRetest: orderBlock,
    },
    candleConfirmation: confirmation,
    maxEntryDistancePips: config.maxEntryDistancePips,
  };

  if (rawManipulations.length && !freshManipulations.length) {
    const closest = Math.min(...rawManipulations.map((item) => Number(item.distancePips)).filter(Number.isFinite));
    return {
      status: 'late',
      reason: `PPR price moved ${closest.toFixed(1)} pips from the manipulation; wait for a retest within ${config.maxEntryDistancePips} pips with all confirmations still valid`,
      ...resultBase,
      pricing,
      direction,
      entry,
      spreadPips: pricing.spreadPips,
      ...evidence,
    };
  }

  if (!manipulation || !volume.detected || !alignedConfirmation) {
    const missing = [];
    if (!manipulation) missing.push('misdirection/manipulation confirmation');
    if (!volume.detected) missing.push('M5 tick-volume spike');
    if (!alignedConfirmation) missing.push(`${bias.bias} rejection candle`);
    return {
      status: manipulation || volume.detected ? 'hot' : 'near',
      reason: `PPR waiting for ${missing.join(', ')}`,
      ...resultBase,
      pricing,
      direction,
      entry,
      spreadPips: pricing.spreadPips,
      ...evidence,
    };
  }

  const buffer = atrValue * config.stopBufferAtr;
  const rawStop = direction === 'long'
    ? Number(manipulation.invalidation) - buffer
    : Number(manipulation.invalidation) + buffer;
  const stopLoss = roundPrice(rawStop, normalizedPair);
  const risk = direction === 'long' ? entry - stopLoss : stopLoss - entry;
  if (!Number.isFinite(risk) || risk <= 0) {
    return {
      status: 'rejected',
      reason: 'PPR manipulation invalidation produced invalid stop geometry',
      ...resultBase,
      pricing,
      direction,
      entry,
      stopLoss,
      spreadPips: pricing.spreadPips,
      ...evidence,
    };
  }

  const target = selectPprLiquidityTarget({
    pools: liquidityPools,
    direction,
    entry,
    stopLoss,
    minRR: config.minRR,
  });
  if (!target) {
    return {
      status: 'rejected',
      reason: `No source-neutral liquidity cluster preserves at least ${config.minRR.toFixed(2)}R`,
      ...resultBase,
      pricing,
      direction,
      entry,
      stopLoss,
      spreadPips: pricing.spreadPips,
      ...evidence,
    };
  }

  const takeProfit = roundPrice(target.price, normalizedPair);
  const reward = direction === 'long' ? takeProfit - entry : entry - takeProfit;
  const rr = reward > 0 ? reward / risk : null;
  if (!Number.isFinite(rr) || rr < config.minRR) {
    return {
      status: 'rejected',
      reason: `PPR liquidity target provides ${Number.isFinite(rr) ? rr.toFixed(2) : 'invalid'}R, below ${config.minRR.toFixed(2)}R`,
      ...resultBase,
      pricing,
      direction,
      entry,
      stopLoss,
      takeProfit,
      rr,
      spreadPips: pricing.spreadPips,
      liquidityTarget: target,
      ...evidence,
    };
  }

  const volumeStrength = Math.min(
    20,
    15 + Math.max(0, (Number(volume.ratio) - config.volumeSpikeMultiplier) * 5),
  );
  const manipulationStrength = Math.min(30, 20 + (manipulation.types.length - 1) * 5);
  const poolStrength = Math.min(10, 5 + Number(target.confluenceScore || 0));
  const confidence = Math.min(
    100,
    Math.round(25 + 15 + volumeStrength + manipulationStrength + poolStrength),
  );
  if (confidence < config.minConfidence) {
    return {
      status: 'hot',
      reason: `PPR confidence ${confidence}% is below ${config.minConfidence}%`,
      ...resultBase,
      pricing,
      direction,
      entry,
      stopLoss,
      takeProfit,
      rr,
      confidence,
      spreadPips: pricing.spreadPips,
      liquidityTarget: target,
      ...evidence,
    };
  }

  const lifecycle = lifecycleFor({
    pair: normalizedPair,
    entry,
    stopLoss,
    takeProfit,
    atrPips,
  });
  const signal = {
    ...resultBase,
    status: 'qualified',
    direction,
    score: Math.max(8, Math.round(confidence / 5)),
    confidence,
    entryQualityConfidence: confidence,
    entry,
    entryPrice: entry,
    currentPrice: entry,
    stopLoss,
    takeProfit,
    rr: Number(rr.toFixed(2)),
    expectedRR: Number(rr.toFixed(2)),
    spreadPips: Number(pricing.spreadPips),
    atrPips,
    volatilityState: volume.ratio >= config.volumeSpikeMultiplier * 1.5 ? 'expanding' : 'active',
    tradeStyle: 'INTRADAY',
    selectedLogicType: 'ppr_native',
    lifecycle,
    ppr: {
      ...evidence,
      liquidityTarget: target,
    },
    pprConfirmation: {
      allowed: true,
      dailyBias: bias.bias,
      dailyEma: config.dailyEma,
      h1Ema: config.h1Ema,
      h1EmaAligned: true,
      targetType: target.type,
      targetSources: target.sources,
      targetConfluenceScore: target.confluenceScore,
      session: session.name,
      volumeSpike: true,
      volumeRatio: volume.ratio,
      manipulationType: manipulation.type,
      manipulationTypes: manipulation.types,
      manipulationSubtypes: manipulation.subtypes,
      manipulationDistancePips: manipulation.distancePips,
      candleConfirmation: confirmation,
      minimumRR: config.minRR,
      managementCutoffEt: '10:00',
      managementAfterCutoff: 'manual_only',
      confirmedAt: manipulation.triggerTime || validCandles(m5).at(-1)?.time || new Date().toISOString(),
    },
    generatedAt: new Date().toISOString(),
    environment: client?.environment || 'practice',
  };

  return {
    status: 'qualified',
    reason: 'PPR EMA9 bias/alignment, liquidity cluster, volume spike, misdirection and geometry confirmed',
    signal,
    ...signal,
  };
}

export async function scanPprMarket({ pairs = null, client, now = new Date(), log = () => {} } = {}) {
  const allowedWatchlist = getPprWatchlist();
  const requested = Array.isArray(pairs) && pairs.length
    ? [...new Set(
      pairs
        .map((pair) => String(pair).trim().toUpperCase())
        .filter((pair) => allowedWatchlist.includes(pair)),
    )]
    : allowedWatchlist;
  const qualified = [];
  const watchCandidates = [];
  const rejected = [];

  for (const pair of requested) {
    try {
      const result = await analyzePprPair({ pair, client, now });
      if (result.status === 'qualified' && result.signal) qualified.push(result.signal);
      else if (result.status === 'near' || result.status === 'hot') watchCandidates.push(result);
      else rejected.push(result);
      log(`pair=${pair} status=${result.status} reason="${result.reason}"`);
    } catch (error) {
      const result = {
        pair,
        engine: 'ppr',
        status: 'rejected',
        reason: `PPR scan failed: ${error?.message || String(error)}`,
      };
      rejected.push(result);
      log(`pair=${pair} status=rejected reason="${result.reason}"`);
    }
  }

  return {
    engine: 'ppr',
    architecture: 'independent_ppr_raw_market_data',
    watchlist: allowedWatchlist,
    qualified,
    watchCandidates,
    rejected,
    meta: {
      pairsScanned: requested.length,
      generatedAt: new Date().toISOString(),
      managementCutoffEt: '10:00',
      afterCutoff: 'manual_only',
      newsPolicy: 'not_configured',
    },
  };
}
