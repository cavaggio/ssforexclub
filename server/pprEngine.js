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
 * - Produces its own Daily EMA bias, liquidity targets, session/volume filter,
 *   manipulation trigger, confidence, stop, target, and executable R:R.
 */

const DEFAULT_PPR_WATCHLIST = [
  'EUR_USD', 'GBP_USD', 'USD_JPY', 'USD_CHF',
  'AUD_USD', 'USD_CAD', 'NZD_USD', 'EUR_GBP',
  'EUR_JPY', 'GBP_JPY', 'EUR_CHF', 'AUD_CAD',
];

const numberEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};

export function pprConfig() {
  return {
    fastEma: Math.max(2, Math.floor(numberEnv('PPR_DAILY_FAST_EMA', 20))),
    slowEma: Math.max(3, Math.floor(numberEnv('PPR_DAILY_SLOW_EMA', 50))),
    minConfidence: Math.max(0, Math.min(100, numberEnv('PPR_MIN_CONFIDENCE', 85))),
    minRR: Math.max(1.5, numberEnv('PPR_MIN_RR', 1.5)),
    volumeLookback: Math.max(5, Math.floor(numberEnv('PPR_VOLUME_LOOKBACK', 20))),
    volumeSpikeMultiplier: Math.max(1, numberEnv('PPR_VOLUME_SPIKE_MULTIPLIER', 1.5)),
    swingLookback: Math.max(1, Math.floor(numberEnv('PPR_SWING_LOOKBACK', 2))),
    stopBufferAtr: Math.max(0.05, numberEnv('PPR_STOP_BUFFER_ATR', 0.15)),
    maxSpreadPips: Math.max(0.1, numberEnv('PPR_MAX_SPREAD_PIPS', numberEnv('FOREX_MAX_SPREAD_PIPS', 5))),
  };
}

export function getPprWatchlist() {
  const configured = String(process.env.PPR_FOREX_WATCHLIST || '')
    .split(',')
    .map((pair) => pair.trim().toUpperCase())
    .filter(Boolean);
  return configured.length ? [...new Set(configured)] : [...DEFAULT_PPR_WATCHLIST];
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

function candleDirection(candle) {
  if (!candle) return 'neutral';
  if (candle.close > candle.open) return 'bullish';
  if (candle.close < candle.open) return 'bearish';
  return 'neutral';
}

export function classifyPprDailyBias(candles, config = pprConfig()) {
  const closes = Array.isArray(candles) ? candles.map((candle) => Number(candle.close)).filter(Number.isFinite) : [];
  const required = Math.max(config.slowEma + 5, config.fastEma + 5);
  if (closes.length < required) {
    return { bias: 'neutral', reason: `Daily EMA data unavailable (${closes.length}/${required})`, fastEma: null, slowEma: null, fastSlope: null };
  }

  const fast = ema(closes, config.fastEma);
  const slow = ema(closes, config.slowEma);
  const fastPast = ema(closes.slice(0, -5), config.fastEma);
  const price = closes.at(-1);
  const fastSlope = Number(fast) - Number(fastPast);

  if ([fast, slow, fastPast, price].some((value) => !Number.isFinite(value))) {
    return { bias: 'neutral', reason: 'Daily EMA calculation is incomplete', fastEma: fast, slowEma: slow, fastSlope: null };
  }

  if (price > fast && fast > slow && fastSlope > 0) {
    return { bias: 'bullish', reason: `Daily close > EMA${config.fastEma} > EMA${config.slowEma} with rising fast EMA`, fastEma: fast, slowEma: slow, fastSlope };
  }
  if (price < fast && fast < slow && fastSlope < 0) {
    return { bias: 'bearish', reason: `Daily close < EMA${config.fastEma} < EMA${config.slowEma} with falling fast EMA`, fastEma: fast, slowEma: slow, fastSlope };
  }

  return { bias: 'neutral', reason: 'Daily price and EMA structure do not establish one directional bias', fastEma: fast, slowEma: slow, fastSlope };
}

export function findPprSwingPools(candles, lookback = 2) {
  const highs = [];
  const lows = [];
  if (!Array.isArray(candles) || candles.length < lookback * 2 + 1) return { highs, lows };

  for (let index = lookback; index < candles.length - lookback; index += 1) {
    const candle = candles[index];
    let swingHigh = true;
    let swingLow = true;
    for (let cursor = index - lookback; cursor <= index + lookback; cursor += 1) {
      if (cursor === index) continue;
      if (candles[cursor].high >= candle.high) swingHigh = false;
      if (candles[cursor].low <= candle.low) swingLow = false;
    }
    if (swingHigh) highs.push({ price: candle.high, time: candle.time, index });
    if (swingLow) lows.push({ price: candle.low, time: candle.time, index });
  }
  return { highs, lows };
}

export function selectPprLiquidityTarget({ pools, direction, entry }) {
  const source = direction === 'long' ? pools?.highs : pools?.lows;
  const valid = (Array.isArray(source) ? source : [])
    .filter((pool) => Number.isFinite(pool.price))
    .filter((pool) => direction === 'long' ? pool.price > entry : pool.price < entry)
    .sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));
  const target = valid[0] || null;
  return target ? { ...target, type: direction === 'long' ? 'swing_high_liquidity' : 'swing_low_liquidity' } : null;
}

export function detectPprVolumeSpike(candles, config = pprConfig()) {
  if (!Array.isArray(candles) || candles.length < config.volumeLookback + 1) {
    return { detected: false, ratio: null, currentVolume: null, averageVolume: null, reason: 'Insufficient M5 tick-volume history' };
  }
  const last = candles.at(-1);
  const baseline = candles.slice(-(config.volumeLookback + 1), -1);
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

function latestReferencePool(pools, direction, currentPrice) {
  const source = direction === 'long' ? pools?.lows : pools?.highs;
  const candidates = (Array.isArray(source) ? source : [])
    .filter((pool) => direction === 'long' ? pool.price < currentPrice : pool.price > currentPrice)
    .sort((a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice));
  return candidates[0] || null;
}

export function detectPprLiquidityRaid({ candles, pools, direction }) {
  if (!Array.isArray(candles) || candles.length < 3) return null;
  const last = candles.at(-1);
  const recent = candles.slice(-4);
  const reference = latestReferencePool(pools, direction, last.close);
  if (!reference) return null;

  if (direction === 'long') {
    const extreme = Math.min(...recent.map((candle) => candle.low));
    if (extreme < reference.price && last.close > reference.price && candleDirection(last) === 'bullish') {
      return {
        type: 'liquidity_raid',
        subtype: 'sell_side_stop_hunt',
        direction: 'bullish',
        level: reference.price,
        invalidation: extreme,
        triggerTime: last.time,
        reason: 'Sell-side swing-low liquidity was raided and price closed back above the pool',
      };
    }
  } else {
    const extreme = Math.max(...recent.map((candle) => candle.high));
    if (extreme > reference.price && last.close < reference.price && candleDirection(last) === 'bearish') {
      return {
        type: 'liquidity_raid',
        subtype: 'buy_side_stop_hunt',
        direction: 'bearish',
        level: reference.price,
        invalidation: extreme,
        triggerTime: last.time,
        reason: 'Buy-side swing-high liquidity was raided and price closed back below the pool',
      };
    }
  }
  return null;
}

export function detectPprFvgMitigation({ candles, direction }) {
  if (!Array.isArray(candles) || candles.length < 8) return null;
  const last = candles.at(-1);
  const end = candles.length - 2;

  for (let index = end; index >= Math.max(2, candles.length - 35); index -= 1) {
    const first = candles[index - 2];
    const third = candles[index];
    if (direction === 'long' && first.high < third.low) {
      const lower = first.high;
      const upper = third.low;
      const overlaps = last.low <= upper && last.high >= lower;
      if (overlaps && last.close > (lower + upper) / 2 && candleDirection(last) === 'bullish') {
        return { type: 'fvg_mitigation', subtype: 'bullish_fvg', direction: 'bullish', zoneLow: lower, zoneHigh: upper, invalidation: lower, triggerTime: last.time, reason: 'Bullish FVG was mitigated and rejected upward' };
      }
    }
    if (direction === 'short' && first.low > third.high) {
      const lower = third.high;
      const upper = first.low;
      const overlaps = last.high >= lower && last.low <= upper;
      if (overlaps && last.close < (lower + upper) / 2 && candleDirection(last) === 'bearish') {
        return { type: 'fvg_mitigation', subtype: 'bearish_fvg', direction: 'bearish', zoneLow: lower, zoneHigh: upper, invalidation: upper, triggerTime: last.time, reason: 'Bearish FVG was mitigated and rejected downward' };
      }
    }
  }
  return null;
}

export function detectPprOrderBlockRetest({ candles, direction, atrValue }) {
  if (!Array.isArray(candles) || candles.length < 10 || !Number.isFinite(atrValue)) return null;
  const last = candles.at(-1);

  for (let index = candles.length - 2; index >= Math.max(2, candles.length - 14); index -= 1) {
    const displacement = candles[index];
    const origin = candles[index - 1];
    const body = Math.abs(displacement.close - displacement.open);
    const alignedDisplacement = direction === 'long'
      ? displacement.close > displacement.open && origin.close < origin.open
      : displacement.close < displacement.open && origin.close > origin.open;
    if (!alignedDisplacement || body < atrValue * 1.2) continue;

    const zoneLow = Math.min(origin.open, origin.close, origin.low);
    const zoneHigh = Math.max(origin.open, origin.close, origin.high);
    const touched = last.low <= zoneHigh && last.high >= zoneLow;
    const rejected = direction === 'long'
      ? candleDirection(last) === 'bullish' && last.close > origin.open
      : candleDirection(last) === 'bearish' && last.close < origin.open;
    if (touched && rejected) {
      return {
        type: 'order_block_retest',
        subtype: direction === 'long' ? 'bullish_order_block' : 'bearish_order_block',
        direction: direction === 'long' ? 'bullish' : 'bearish',
        zoneLow,
        zoneHigh,
        invalidation: direction === 'long' ? zoneLow : zoneHigh,
        triggerTime: last.time,
        reason: 'Price mitigated the last opposing candle before displacement and rejected with the Daily bias',
      };
    }
  }
  return null;
}

export function pprSession(now = new Date()) {
  const et = etParts(now);
  if (!et || et.isWeekend) return { allowed: false, name: 'closed', minutes: null, reason: 'PPR runs Monday through Friday only' };
  const minutes = et.minutesFromMidnight;
  if (minutes < 120 || minutes >= 600) return { allowed: false, name: 'closed', minutes, reason: 'Outside the 02:00–10:00 ET PPR entry window' };
  const name = minutes < 300 ? 'London' : minutes < 420 ? 'London_to_New_York' : 'New_York_AM';
  return { allowed: true, name, minutes, reason: `${name.replaceAll('_', ' ')} PPR session` };
}

function executableEntry(pricing, direction) {
  return direction === 'long' ? Number(pricing?.ask) : Number(pricing?.bid);
}

function lifecycleFor({ pair, direction, entry, stopLoss, takeProfit, atrPips }) {
  const pipSize = pprPipSize(pair);
  const stopLossPips = Math.abs(entry - stopLoss) / pipSize;
  const takeProfitPips = Math.abs(takeProfit - entry) / pipSize;
  return {
    allowed: true,
    source: 'ppr_native_geometry',
    sl: { stopLossPips, stopLossPrice: stopLoss },
    tp: { allowed: true, takeProfitPips, takeProfitPrice: takeProfit },
    hold: { style: 'intraday', maxHoldMinutes: 240 },
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
    session,
  };

  if (!session.allowed) return { status: 'rejected', reason: session.reason, ...resultBase };

  const [daily, h1, m15, m5, pricingRows] = await Promise.all([
    getCandles(normalizedPair, 'D', 120, { client }),
    getCandles(normalizedPair, 'H1', 180, { client }),
    getCandles(normalizedPair, 'M15', 180, { client }),
    getCandles(normalizedPair, 'M5', 180, { client }),
    getPricing([normalizedPair], { client }),
  ]);
  const pricing = Array.isArray(pricingRows) ? pricingRows.find((row) => row.instrument === normalizedPair) : null;
  if (!pricing || pricing.tradeable === false) return { status: 'rejected', reason: 'No tradeable executable OANDA quote', ...resultBase };
  if (Number(pricing.spreadPips) > config.maxSpreadPips) return { status: 'rejected', reason: `Spread ${pricing.spreadPips}p exceeds PPR cap ${config.maxSpreadPips}p`, ...resultBase, pricing };

  const bias = classifyPprDailyBias(daily, config);
  if (bias.bias === 'neutral') return { status: 'near', reason: bias.reason, ...resultBase, pricing, dailyBias: bias };

  const direction = bias.bias === 'bullish' ? 'long' : 'short';
  const entry = executableEntry(pricing, direction);
  if (!Number.isFinite(entry) || entry <= 0) return { status: 'rejected', reason: 'Executable bid/ask is invalid', ...resultBase, pricing, dailyBias: bias };

  const h1Pools = findPprSwingPools(h1, config.swingLookback);
  const m15Pools = findPprSwingPools(m15, config.swingLookback);
  const target = selectPprLiquidityTarget({ pools: h1Pools, direction, entry });
  if (!target) return { status: 'near', reason: 'No unconsumed H1 swing liquidity target exists in the Daily-bias direction', ...resultBase, pricing, dailyBias: bias, direction, liquidityPools: h1Pools };

  const atrValue = atr(m5, 14);
  const atrPips = Number.isFinite(atrValue) ? atrValue / pprPipSize(normalizedPair) : null;
  if (!Number.isFinite(atrValue) || atrValue <= 0) return { status: 'near', reason: 'M5 ATR is unavailable for PPR geometry', ...resultBase, pricing, dailyBias: bias, direction, liquidityTarget: target };

  const volume = detectPprVolumeSpike(m5, config);
  const raid = detectPprLiquidityRaid({ candles: m5, pools: m15Pools, direction });
  const fvg = detectPprFvgMitigation({ candles: m5, direction });
  const orderBlock = detectPprOrderBlockRetest({ candles: m5, direction, atrValue });
  const manipulation = raid || fvg || orderBlock;
  const confirmation = candleDirection(m5.at(-1));
  const alignedConfirmation = confirmation === bias.bias;

  const evidence = {
    dailyBias: bias,
    liquidityTarget: target,
    volume,
    manipulation,
    alternatives: { liquidityRaid: raid, fvgMitigation: fvg, orderBlockRetest: orderBlock },
    candleConfirmation: confirmation,
  };

  if (!manipulation || !volume.detected || !alignedConfirmation) {
    const missing = [];
    if (!manipulation) missing.push('manipulation trigger');
    if (!volume.detected) missing.push('M5 volume/liquidity spike');
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
  const takeProfit = roundPrice(target.price, normalizedPair);
  const risk = direction === 'long' ? entry - stopLoss : stopLoss - entry;
  const reward = direction === 'long' ? takeProfit - entry : entry - takeProfit;
  const rr = risk > 0 && reward > 0 ? reward / risk : null;

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
      ...evidence,
    };
  }

  const volumeStrength = Math.min(20, 15 + Math.max(0, (Number(volume.ratio) - config.volumeSpikeMultiplier) * 5));
  const confidence = Math.min(100, Math.round(25 + 15 + volumeStrength + 25 + 10 + 5));
  if (confidence < config.minConfidence) {
    return { status: 'hot', reason: `PPR confidence ${confidence}% is below ${config.minConfidence}%`, ...resultBase, pricing, direction, entry, stopLoss, takeProfit, rr, confidence, spreadPips: pricing.spreadPips, ...evidence };
  }

  const lifecycle = lifecycleFor({ pair: normalizedPair, direction, entry, stopLoss, takeProfit, atrPips });
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
    ppr: evidence,
    pprConfirmation: {
      allowed: true,
      dailyBias: bias.bias,
      targetType: target.type,
      session: session.name,
      volumeSpike: true,
      manipulationType: manipulation.type,
      manipulationSubtype: manipulation.subtype,
      candleConfirmation: confirmation,
      minimumRR: config.minRR,
      confirmedAt: m5.at(-1)?.time || new Date().toISOString(),
    },
    generatedAt: new Date().toISOString(),
    environment: client?.environment || 'practice',
  };

  return { status: 'qualified', reason: 'PPR Daily bias, liquidity target, session, volume spike, manipulation, and geometry confirmed', signal, ...signal };
}

export async function scanPprMarket({ pairs = null, client, now = new Date(), log = () => {} } = {}) {
  const requested = Array.isArray(pairs) && pairs.length
    ? [...new Set(pairs.map((pair) => String(pair).trim().toUpperCase()).filter(Boolean))]
    : getPprWatchlist();
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
      const result = { pair, engine: 'ppr', status: 'rejected', reason: `PPR scan failed: ${error?.message || String(error)}` };
      rejected.push(result);
      log(`pair=${pair} status=rejected reason="${result.reason}"`);
    }
  }

  return {
    engine: 'ppr',
    architecture: 'independent_ppr_raw_market_data',
    qualified,
    watchCandidates,
    rejected,
    meta: { pairsScanned: requested.length, generatedAt: new Date().toISOString() },
  };
}
