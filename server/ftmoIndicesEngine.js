import { ftmoIndicesConfig, instrumentRiskMultiplier } from './ftmoIndicesConfig.js';

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const round = (value, digits = 2) => Number(Number(value).toFixed(digits));

function etParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(now).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
  return { ...parts, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function classifyFtmoIndicesSession(now = new Date()) {
  const et = etParts(now);
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(et.weekday);
  const primary = et.minutes >= 570 && et.minutes <= 660;
  const secondary = et.minutes >= 840 && et.minutes <= 945;
  const lunch = et.minutes >= 690 && et.minutes <= 810;
  return {
    timezone: 'America/New_York',
    weekday,
    primary,
    secondary,
    lunch,
    executable: weekday && !lunch && (primary || secondary),
    label: primary ? 'NEW_YORK_OPEN' : secondary ? 'POWER_HOUR' : lunch ? 'LUNCH_BLOCK' : 'OUTSIDE_WINDOW',
  };
}

function candleDirection(candle) {
  const open = finite(candle?.open);
  const close = finite(candle?.close);
  if (open == null || close == null || open === close) return 'neutral';
  return close > open ? 'bullish' : 'bearish';
}

function range(candle) {
  const high = finite(candle?.high);
  const low = finite(candle?.low);
  return high == null || low == null ? 0 : Math.max(0, high - low);
}

export function detectIndicesDisplacement(candles = [], direction) {
  const recent = candles.slice(-20);
  if (recent.length < 6) return { present: false, reason: 'Insufficient candles' };
  const ranges = recent.slice(0, -1).map(range).filter((value) => value > 0).sort((a, b) => a - b);
  const median = ranges[Math.floor(ranges.length / 2)] || 0;
  const candle = recent.at(-1);
  const candleRange = range(candle);
  const body = Math.abs(finite(candle?.close) - finite(candle?.open));
  const aligned = candleDirection(candle) === direction;
  const present = aligned && median > 0 && candleRange >= median * 1.5 && body >= candleRange * 0.6;
  return { present, aligned, candleRange, medianRange: median, bodyRatio: candleRange ? body / candleRange : 0 };
}

export function detectIndicesSweep(candles = [], direction) {
  const recent = candles.slice(-30);
  if (recent.length < 8) return { present: false, reason: 'Insufficient candles' };
  const trigger = recent.at(-1);
  const history = recent.slice(0, -1);
  const priorHigh = Math.max(...history.map((c) => finite(c.high)).filter(Number.isFinite));
  const priorLow = Math.min(...history.map((c) => finite(c.low)).filter(Number.isFinite));
  const high = finite(trigger.high);
  const low = finite(trigger.low);
  const close = finite(trigger.close);
  if ([priorHigh, priorLow, high, low, close].some((value) => value == null)) return { present: false, reason: 'Invalid OHLC' };
  if (direction === 'bullish') {
    return { present: low < priorLow && close > priorLow, sweptLevel: priorLow, side: 'sell_side' };
  }
  return { present: high > priorHigh && close < priorHigh, sweptLevel: priorHigh, side: 'buy_side' };
}

export function detectIndicesStructureShift(candles = [], direction) {
  const recent = candles.slice(-12);
  if (recent.length < 6) return { present: false, reason: 'Insufficient candles' };
  const latest = recent.at(-1);
  const reference = recent.slice(0, -1);
  const swingHigh = Math.max(...reference.map((c) => finite(c.high)).filter(Number.isFinite));
  const swingLow = Math.min(...reference.map((c) => finite(c.low)).filter(Number.isFinite));
  const close = finite(latest.close);
  const present = direction === 'bullish' ? close > swingHigh : close < swingLow;
  return { present, type: present ? (direction === 'bullish' ? 'BOS_UP' : 'BOS_DOWN') : null, swingHigh, swingLow };
}

export function findIndicesPdArray(candles = [], direction) {
  const recent = candles.slice(-40);
  for (let index = recent.length - 2; index >= 2; index -= 1) {
    const left = recent[index - 1];
    const middle = recent[index];
    const right = recent[index + 1];
    if (direction === 'bullish' && finite(left.high) < finite(right.low)) {
      return { present: true, type: 'FVG', low: finite(left.high), high: finite(right.low), midpoint: round((finite(left.high) + finite(right.low)) / 2, 2), sourceIndex: index };
    }
    if (direction === 'bearish' && finite(left.low) > finite(right.high)) {
      return { present: true, type: 'FVG', low: finite(right.high), high: finite(left.low), midpoint: round((finite(right.high) + finite(left.low)) / 2, 2), sourceIndex: index };
    }
    if (candleDirection(middle) !== direction && range(middle) > 0) {
      return { present: true, type: 'ORDER_BLOCK', low: finite(middle.low), high: finite(middle.high), midpoint: round((finite(middle.low) + finite(middle.high)) / 2, 2), sourceIndex: index };
    }
  }
  return { present: false };
}

function normalizeBias(value) {
  const bias = String(value || '').toLowerCase();
  if (['bullish', 'long', 'buy'].includes(bias)) return 'bullish';
  if (['bearish', 'short', 'sell'].includes(bias)) return 'bearish';
  return null;
}

export function analyzeFtmoIndexSetup(input = {}, env = process.env) {
  const config = ftmoIndicesConfig(env);
  const symbol = String(input.symbol || '').trim();
  const dailyBias = normalizeBias(input.dailyBias);
  const fourHourBias = normalizeBias(input.fourHourBias);
  const oneHourBias = normalizeBias(input.oneHourBias);
  const direction = dailyBias && dailyBias === fourHourBias ? dailyBias : (fourHourBias && fourHourBias === oneHourBias ? fourHourBias : null);
  const session = classifyFtmoIndicesSession(input.now ? new Date(input.now) : new Date());
  const candles = Array.isArray(input.candles5m) ? input.candles5m : [];
  const sweep = detectIndicesSweep(candles, direction);
  const displacement = detectIndicesDisplacement(candles, direction);
  const structure = detectIndicesStructureShift(candles, direction);
  const pdArray = findIndicesPdArray(candles, direction);
  const reasons = [];
  if (!config.symbols.includes(symbol)) reasons.push('SYMBOL_NOT_CONFIGURED');
  if (!direction) reasons.push('HTF_BIAS_NOT_ALIGNED');
  if (!session.executable) reasons.push(`SESSION_${session.label}`);
  if (config.requireSweep && !sweep.present) reasons.push('LIQUIDITY_SWEEP_REQUIRED');
  if (config.requireDisplacement && !displacement.present) reasons.push('DISPLACEMENT_REQUIRED');
  if (config.requireStructureShift && !structure.present) reasons.push('STRUCTURE_SHIFT_REQUIRED');
  if (config.requirePdArray && !pdArray.present) reasons.push('PD_ARRAY_REQUIRED');
  if (!config.allowMarketFallback && !pdArray.present) reasons.push('MARKET_FALLBACK_DISABLED');

  let confidence = direction ? 45 : 0;
  confidence += session.primary ? 12 : session.secondary ? 8 : 0;
  confidence += sweep.present ? 15 : 0;
  confidence += displacement.present ? 12 : 0;
  confidence += structure.present ? 10 : 0;
  confidence += pdArray.present ? 8 : 0;
  confidence = Math.min(100, confidence);
  if (confidence < config.minConfidence) reasons.push('CONFIDENCE_BELOW_FLOOR');

  const latest = candles.at(-1) || {};
  const entry = finite(input.entry) ?? finite(latest.close);
  const atr = Math.max(0, finite(input.atr) ?? range(latest));
  const stopBuffer = Math.max(atr * 0.25, finite(input.minStopBuffer) ?? 0);
  const swept = finite(sweep.sweptLevel);
  const stopLoss = direction === 'bullish'
    ? round(Math.min(swept ?? entry, finite(pdArray.low) ?? entry) - stopBuffer, 2)
    : direction === 'bearish'
      ? round(Math.max(swept ?? entry, finite(pdArray.high) ?? entry) + stopBuffer, 2)
      : null;
  const riskDistance = entry != null && stopLoss != null ? Math.abs(entry - stopLoss) : null;
  const target = direction === 'bullish'
    ? round(entry + riskDistance * config.minRR, 2)
    : direction === 'bearish'
      ? round(entry - riskDistance * config.minRR, 2)
      : null;
  if (!(riskDistance > 0)) reasons.push('INVALID_RISK_GEOMETRY');

  const qualified = reasons.length === 0;
  return {
    engine: config.engineId,
    symbol,
    qualified,
    decision: qualified ? 'QUALIFIED' : 'REJECTED',
    reasons: [...new Set(reasons)],
    direction,
    confidence,
    session,
    concepts: { sweep, displacement, structure, pdArray },
    levels: { entry, idealEntry: pdArray.midpoint ?? null, stopLoss, target, rr: config.minRR },
    risk: { multiplier: instrumentRiskMultiplier(symbol), requestedRiskPercent: config.riskPercent * instrumentRiskMultiplier(symbol) },
    createdAt: new Date().toISOString(),
  };
}

export function calculateFtmoIndexVolume({ equity, riskPercent, entry, stopLoss, tickSize, tickValue, volumeMin, volumeMax, volumeStep }) {
  const values = [equity, riskPercent, entry, stopLoss, tickSize, tickValue, volumeMin, volumeStep].map(Number);
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) throw new Error('Invalid FTMO symbol specification or risk input');
  const [accountEquity, riskPct, entryPrice, stopPrice, size, value, min, step] = values;
  const max = Number.isFinite(Number(volumeMax)) && Number(volumeMax) > 0 ? Number(volumeMax) : Number.POSITIVE_INFINITY;
  const stopTicks = Math.abs(entryPrice - stopPrice) / size;
  if (!(stopTicks > 0)) throw new Error('Stop distance must be greater than zero');
  const raw = (accountEquity * (riskPct / 100)) / (stopTicks * value);
  const stepped = Math.floor(raw / step) * step;
  if (stepped < min) throw new Error('Calculated volume is below broker minimum');
  return Math.min(max, Number(stepped.toFixed(8)));
}
