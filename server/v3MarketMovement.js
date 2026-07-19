import { atr } from './oandaIndicators.js';
import {
  detectBreakOfStructure,
  detectChangeOfCharacter,
  detectRangeBreakout,
  detectRetest,
} from './oandaInstitutionalFlow.js';

export const V3_MARKET_ENTRY_POLICY_VERSION = 'v3-market-movement-entry-v1-2026-07-17';

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function normalizeDirection(value) {
  const direction = String(value || '').trim().toLowerCase();
  if (direction === 'buy' || direction === 'bullish') return 'long';
  if (direction === 'sell' || direction === 'bearish') return 'short';
  return direction === 'long' || direction === 'short' ? direction : null;
}

function directionSign(direction) {
  return normalizeDirection(direction) === 'long' ? 'bullish' : normalizeDirection(direction) === 'short' ? 'bearish' : null;
}

function pipSizeFor(pair = '') {
  if (String(pair).includes('JPY')) return 0.01;
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return 0.01;
  return 0.0001;
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validCandles(candles = []) {
  return Array.isArray(candles)
    ? candles
        .map((candle) => ({
          ...candle,
          open: finite(candle?.open),
          high: finite(candle?.high),
          low: finite(candle?.low),
          close: finite(candle?.close),
        }))
        .filter((candle) => [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite))
    : [];
}

function eventTimestamp(event = {}) {
  const raw = event?.time || event?.timestamp || event?.candleTime || event?.detectedAt || null;
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function eventAgeBars(event, referenceTime, barMinutes = 15) {
  const eventTime = eventTimestamp(event);
  const reference = eventTimestamp({ time: referenceTime });
  if (eventTime === null || reference === null) return null;
  return Math.max(0, (reference - eventTime) / (barMinutes * 60_000));
}

function triggerPrice(event = null, fallback = null) {
  const source = event && typeof event === 'object' ? event : {};
  const values = [
    source.triggerPrice,
    source.reclaimClose,
    source.retestPrice,
    source.retestLevel,
    source.brokenLevel,
    source.close,
    source.sweptPriceLevel,
    fallback,
  ];
  for (const value of values) {
    const number = finite(value);
    if (number !== null) return number;
  }
  return null;
}

function latestAlignedSweep({ candles, direction, pair, referenceTime }) {
  if (candles.length < 30) return { confirmed: null, pending: null };
  const sign = directionSign(direction);
  const recentCount = Math.min(12, Math.max(6, candles.length - 20));
  const recentStart = candles.length - recentCount;
  const recent = candles.slice(recentStart);
  const baseline = candles.slice(Math.max(0, recentStart - 40), recentStart);
  if (baseline.length < 12) return { confirmed: null, pending: null };

  const baselineHigh = Math.max(...baseline.map((candle) => candle.high));
  const baselineLow = Math.min(...baseline.map((candle) => candle.low));
  const wantLong = sign === 'bullish';

  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const sweepCandle = recent[index];
    const pierced = wantLong ? sweepCandle.low < baselineLow : sweepCandle.high > baselineHigh;
    if (!pierced) continue;

    const sweptPriceLevel = wantLong ? baselineLow : baselineHigh;
    const confirmation = recent
      .slice(index)
      .find((candle) => wantLong ? candle.close > sweptPriceLevel : candle.close < sweptPriceLevel);

    if (confirmation) {
      const event = {
        type: 'confirmed_liquidity_sweep',
        sourceType: 'liquidity_sweep',
        direction: sign,
        timeframe: 'M15',
        time: confirmation.time || referenceTime || null,
        sweepTime: sweepCandle.time || null,
        triggerPrice: confirmation.close,
        reclaimClose: confirmation.close,
        sweptPriceLevel,
        pair,
        confirmed: true,
        pending: false,
        reason: wantLong
          ? `Sell-side liquidity below ${sweptPriceLevel} was swept and price closed back above the level.`
          : `Buy-side liquidity above ${sweptPriceLevel} was swept and price closed back below the level.`,
      };
      return { confirmed: event, pending: null };
    }

    return {
      confirmed: null,
      pending: {
        type: 'pending_liquidity_sweep',
        sourceType: 'liquidity_sweep',
        direction: sign,
        timeframe: 'M15',
        time: sweepCandle.time || referenceTime || null,
        triggerPrice: sweepCandle.close,
        sweptPriceLevel,
        pair,
        confirmed: false,
        pending: true,
        reason: wantLong
          ? `Sell-side liquidity was pierced, but price has not closed back above ${sweptPriceLevel}.`
          : `Buy-side liquidity was pierced, but price has not closed back below ${sweptPriceLevel}.`,
      },
    };
  }

  return { confirmed: null, pending: null };
}

function alignedEvent(event, direction) {
  if (!event) return null;
  const sign = directionSign(direction);
  const eventDirection = String(event.direction || '').toLowerCase();
  if (eventDirection && sign && eventDirection !== sign) return null;
  return event;
}

function addEvent(events, event, type, timeframe, fallbackPrice = null) {
  if (!event) return;
  events.push({
    ...event,
    type,
    sourceType: event.type || type,
    timeframe: event.timeframe || timeframe,
    triggerPrice: triggerPrice(event, fallbackPrice),
    confirmed: true,
    pending: false,
  });
}

function selectBestTrigger(events = [], referenceTime) {
  const priority = {
    confirmed_retest: 6,
    confirmed_liquidity_sweep: 5,
    fresh_aligned_choch: 4,
    fresh_aligned_bos: 3,
    range_breakout: 2,
    compression_to_expansion: 1,
  };

  return [...events]
    .sort((left, right) => {
      const leftTime = eventTimestamp(left) ?? 0;
      const rightTime = eventTimestamp(right) ?? 0;
      if (leftTime !== rightTime) return rightTime - leftTime;
      return (priority[right.type] || 0) - (priority[left.type] || 0);
    })
    .find((event) => eventTimestamp(event) !== null || referenceTime) || null;
}

/**
 * Build the pair-specific Stage 2 movement state from raw M15/H1 price action.
 * Fibonacci is intentionally absent. The entry window is defined by the latest
 * confirmed market event, its age, and how far current price has moved from it
 * relative to this pair's ATR.
 */
export function analyzeV3MarketMovement({
  pair,
  direction,
  m15Candles = [],
  h1Candles = [],
  currentPrice = null,
  atrPips = null,
  structure = null,
  volatility = null,
} = {}) {
  const normalizedDirection = normalizeDirection(direction);
  const sign = directionSign(normalizedDirection);
  const m15 = validCandles(m15Candles);
  const h1 = validCandles(h1Candles);
  const latestM15 = m15.at(-1) || null;
  const referenceTime = latestM15?.time || new Date().toISOString();
  const price = finite(currentPrice) ?? latestM15?.close ?? null;
  const pipSize = pipSizeFor(pair);
  const computedAtrPrice = m15.length >= 20 ? atr(m15, 14) : null;
  const atrPrice = finite(atrPips) !== null && finite(atrPips) > 0
    ? finite(atrPips) * pipSize
    : finite(computedAtrPrice);

  const maxTriggerBars = envNumber('V3_ENTRY_TRIGGER_MAX_BARS', 3);
  const maxDistanceAtr = envNumber('V3_ENTRY_MAX_TRIGGER_DISTANCE_ATR', 0.65);
  const maxAdverseAtr = envNumber('V3_ENTRY_MAX_ADVERSE_DISTANCE_ATR', 0.25);
  const events = [];
  const pendingEvents = [];

  const sweep = latestAlignedSweep({ candles: m15, direction: normalizedDirection, pair, referenceTime });
  if (sweep.confirmed) events.push(sweep.confirmed);
  if (sweep.pending) pendingEvents.push(sweep.pending);

  if (normalizedDirection && m15.length >= 25) {
    const retest = alignedEvent(detectRetest({ candles: m15, direction: normalizedDirection, pair }), normalizedDirection);
    if (retest) {
      addEvent(events, { ...retest, time: latestM15?.time || null, triggerPrice: latestM15?.close }, 'confirmed_retest', 'M15', price);
    }

    const rangeBreakout = alignedEvent(detectRangeBreakout({ candles: m15, pair }), normalizedDirection);
    if (rangeBreakout) {
      addEvent(events, { ...rangeBreakout, time: latestM15?.time || null, triggerPrice: latestM15?.close }, 'range_breakout', 'M15', price);
    }

    const m15Bos = alignedEvent(detectBreakOfStructure({ candles: m15, direction: normalizedDirection, pair }), normalizedDirection);
    if (m15Bos) {
      addEvent(events, { ...m15Bos, time: latestM15?.time || m15Bos.time || null }, 'fresh_aligned_bos', 'M15', price);
    }
  }

  const priorTrend = String(structure?.structureTrend || '').toLowerCase();
  if (normalizedDirection && h1.length >= 25 && (priorTrend === 'bullish' || priorTrend === 'bearish')) {
    const h1Choch = alignedEvent(detectChangeOfCharacter({ candles: h1, priorTrend, pair }), normalizedDirection);
    if (h1Choch) {
      addEvent(events, { ...h1Choch, time: h1.at(-1)?.time || h1Choch.time || null }, 'fresh_aligned_choch', 'H1', price);
    }
  }

  const structureBos = alignedEvent(structure?.bosDetected === true ? structure?.bos : null, normalizedDirection);
  const structureChoch = alignedEvent(structure?.chochDetected === true ? structure?.choch : null, normalizedDirection);
  if (structureChoch) addEvent(events, structureChoch, 'fresh_aligned_choch', structure?.timeframeUsed || 'H1', price);
  if (structureBos) addEvent(events, structureBos, 'fresh_aligned_bos', structure?.timeframeUsed || 'H1', price);

  const volatilityState = String(volatility?.volatilityState || '').toLowerCase();
  if (volatilityState === 'expanding' && latestM15) {
    events.push({
      type: 'compression_to_expansion',
      sourceType: 'volatility_expansion',
      direction: sign,
      timeframe: 'M15',
      time: latestM15.time || referenceTime,
      triggerPrice: latestM15.close,
      confirmed: true,
      pending: false,
      reason: 'M15 volatility expanded after compression.',
    });
  }

  const deduped = [];
  const seen = new Set();
  for (const event of events) {
    const key = `${event.type}|${event.time || 'na'}|${event.triggerPrice ?? 'na'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }

  const trigger = selectBestTrigger(deduped, referenceTime);
  const triggerTimeframeMinutes = trigger?.timeframe === 'H1' ? 60 : trigger?.timeframe === 'H4' ? 240 : 15;
  const ageBars = trigger ? eventAgeBars(trigger, referenceTime, triggerTimeframeMinutes) : null;
  const eventPrice = triggerPrice(trigger, price);
  const signedDistance = trigger && price !== null && eventPrice !== null
    ? normalizedDirection === 'long' ? price - eventPrice : eventPrice - price
    : null;
  const distancePips = signedDistance !== null ? signedDistance / pipSize : null;
  const distanceAtr = signedDistance !== null && atrPrice !== null && atrPrice > 0
    ? signedDistance / atrPrice
    : null;

  const recentRange = m15.slice(-12);
  const rangeHigh = recentRange.length ? Math.max(...recentRange.map((candle) => candle.high)) : null;
  const rangeLow = recentRange.length ? Math.min(...recentRange.map((candle) => candle.low)) : null;
  const rangeSize = rangeHigh !== null && rangeLow !== null ? rangeHigh - rangeLow : null;
  const consolidating = volatilityState === 'compressed' || Boolean(
    rangeSize !== null && atrPrice !== null && atrPrice > 0 && rangeSize <= atrPrice * 1.4,
  );

  return {
    policyVersion: V3_MARKET_ENTRY_POLICY_VERSION,
    pair,
    direction: normalizedDirection,
    referenceTime,
    currentPrice: price,
    atrPips: atrPrice !== null ? Number((atrPrice / pipSize).toFixed(2)) : null,
    atrPrice,
    consolidating,
    rangeHigh,
    rangeLow,
    events: deduped,
    pendingEvents,
    trigger,
    triggerConfirmed: Boolean(trigger),
    triggerType: trigger?.type || null,
    triggerTime: trigger?.time || null,
    triggerPrice: eventPrice,
    triggerAgeBars: ageBars === null ? null : Number(ageBars.toFixed(2)),
    triggerDistancePips: distancePips === null ? null : Number(distancePips.toFixed(2)),
    triggerDistanceAtr: distanceAtr === null ? null : Number(distanceAtr.toFixed(3)),
    maxTriggerBars,
    maxDistanceAtr,
    maxAdverseAtr,
    fibUsedForConfirmation: false,
  };
}

export function deriveMarketMovementEntryTiming({
  movement = null,
  alignment = null,
  sweepBlock = null,
  reversal = null,
} = {}) {
  const checkedAt = new Date().toISOString();

  if (!movement?.direction || alignment?.passed !== true) {
    return {
      status: 'invalidated',
      reason: alignment?.reason || 'Daily/H4 alignment is not executable',
      timingSource: 'pair_market_movement',
      triggerConfirmed: false,
      fibUsedForConfirmation: false,
      checkedAt,
    };
  }

  if (sweepBlock?.allowed === false) {
    return {
      status: 'invalidated',
      reason: sweepBlock.reason || 'An opposing confirmed liquidity sweep invalidated the setup',
      timingSource: 'pair_market_movement',
      triggerConfirmed: false,
      fibUsedForConfirmation: false,
      checkedAt,
    };
  }

  if (movement.pendingEvents?.length > 0) {
    const pending = movement.pendingEvents[0];
    return {
      status: 'wait_for_retest',
      reason: pending.reason || 'Liquidity was pierced; waiting for the close-back/reclaim confirmation.',
      timingSource: 'pair_market_movement',
      triggerConfirmed: false,
      pendingTriggerType: pending.type,
      fibUsedForConfirmation: false,
      checkedAt,
    };
  }

  if (!movement.trigger) {
    return {
      status: 'too_early',
      reason: 'No fresh market-movement entry trigger yet: waiting for an aligned sweep/reclaim, retest, BOS/CHoCH, or compression expansion.',
      timingSource: 'pair_market_movement',
      triggerConfirmed: false,
      fibUsedForConfirmation: false,
      checkedAt,
    };
  }

  if (reversal?.allowed === false) {
    return {
      status: 'wait_for_retest',
      reason: reversal.reason || 'The reversal sequence requires a confirmed retest or aligned sweep.',
      timingSource: 'pair_market_movement',
      triggerConfirmed: true,
      triggerType: movement.triggerType,
      triggerTime: movement.triggerTime,
      triggerPrice: movement.triggerPrice,
      fibUsedForConfirmation: false,
      checkedAt,
    };
  }

  if (movement.triggerAgeBars !== null && movement.triggerAgeBars > movement.maxTriggerBars) {
    return {
      status: 'late_entry',
      reason: `The ${movement.triggerType} entry event is ${movement.triggerAgeBars.toFixed(1)} bars old; the ${movement.maxTriggerBars}-bar execution window has passed.`,
      timingSource: 'pair_market_movement',
      triggerConfirmed: true,
      triggerType: movement.triggerType,
      triggerTime: movement.triggerTime,
      triggerPrice: movement.triggerPrice,
      triggerAgeBars: movement.triggerAgeBars,
      triggerDistancePips: movement.triggerDistancePips,
      triggerDistanceAtr: movement.triggerDistanceAtr,
      fibUsedForConfirmation: false,
      checkedAt,
    };
  }

  if (movement.triggerDistanceAtr !== null && movement.triggerDistanceAtr < -movement.maxAdverseAtr) {
    return {
      status: 'invalidated',
      reason: `Price moved ${Math.abs(movement.triggerDistanceAtr).toFixed(2)} ATR against the ${movement.triggerType} entry event.`,
      timingSource: 'pair_market_movement',
      triggerConfirmed: true,
      triggerType: movement.triggerType,
      triggerTime: movement.triggerTime,
      triggerPrice: movement.triggerPrice,
      triggerAgeBars: movement.triggerAgeBars,
      triggerDistancePips: movement.triggerDistancePips,
      triggerDistanceAtr: movement.triggerDistanceAtr,
      fibUsedForConfirmation: false,
      checkedAt,
    };
  }

  if (movement.triggerDistanceAtr !== null && movement.triggerDistanceAtr > movement.maxDistanceAtr) {
    return {
      status: 'late_entry',
      reason: `Price has already moved ${movement.triggerDistanceAtr.toFixed(2)} ATR from the ${movement.triggerType} entry event; do not chase the move.`,
      timingSource: 'pair_market_movement',
      triggerConfirmed: true,
      triggerType: movement.triggerType,
      triggerTime: movement.triggerTime,
      triggerPrice: movement.triggerPrice,
      triggerAgeBars: movement.triggerAgeBars,
      triggerDistancePips: movement.triggerDistancePips,
      triggerDistanceAtr: movement.triggerDistanceAtr,
      fibUsedForConfirmation: false,
      checkedAt,
    };
  }

  const needsRetestInRange = movement.consolidating && [
    'range_breakout',
    'compression_to_expansion',
    'fresh_aligned_bos',
  ].includes(movement.triggerType);
  const hasConfirmedRetest = movement.events?.some((event) => event.type === 'confirmed_retest');
  if (needsRetestInRange && !hasConfirmedRetest) {
    return {
      status: 'wait_for_retest',
      reason: 'The pair is consolidating; the breakout must retest and hold before execution.',
      timingSource: 'pair_market_movement',
      triggerConfirmed: true,
      triggerType: movement.triggerType,
      triggerTime: movement.triggerTime,
      triggerPrice: movement.triggerPrice,
      triggerAgeBars: movement.triggerAgeBars,
      triggerDistancePips: movement.triggerDistancePips,
      triggerDistanceAtr: movement.triggerDistanceAtr,
      fibUsedForConfirmation: false,
      checkedAt,
    };
  }

  return {
    status: 'valid_entry',
    reason: `Fresh ${movement.triggerType} confirmed; price remains within ${movement.maxDistanceAtr.toFixed(2)} ATR of the pair-specific entry event.`,
    timingSource: 'pair_market_movement',
    triggerConfirmed: true,
    triggerType: movement.triggerType,
    triggerTime: movement.triggerTime,
    triggerPrice: movement.triggerPrice,
    triggerAgeBars: movement.triggerAgeBars,
    triggerDistancePips: movement.triggerDistancePips,
    triggerDistanceAtr: movement.triggerDistanceAtr,
    fibUsedForConfirmation: false,
    checkedAt,
  };
}
