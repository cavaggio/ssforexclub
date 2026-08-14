/**
 * Central ICT market-maker execution model.
 *
 * A trade day begins with a persisted 02:00 ET study. Each pair then advances
 * through one ordered Power-of-Three cycle:
 *
 *   STUDIED_ACCUMULATION -> HTF_KEY_TAPPED -> MANIPULATION_CONFIRMED
 *   -> DISPLACEMENT_CONFIRMED -> DISTRIBUTION_ACTIVE
 *
 * Initial entries may activate only on the complete reversal sequence. Later
 * continuation entries must belong to that activated cycle and keep H1 aligned
 * with the Daily/H4 direction.
 */

import { detectFVGs, detectOrderBlock } from './ictConcepts.js';
import { roundPrice } from './pipMath.js';

export const ICT_MARKET_MAKER_STAGES = Object.freeze({
  STUDIED: 'STUDIED_ACCUMULATION',
  KEY_TAPPED: 'HTF_KEY_TAPPED',
  MANIPULATION: 'MANIPULATION_CONFIRMED',
  DISPLACEMENT: 'DISPLACEMENT_CONFIRMED',
  ACTIVE: 'DISTRIBUTION_ACTIVE',
});

const STAGE_RANK = Object.freeze({
  [ICT_MARKET_MAKER_STAGES.STUDIED]: 0,
  [ICT_MARKET_MAKER_STAGES.KEY_TAPPED]: 1,
  [ICT_MARKET_MAKER_STAGES.MANIPULATION]: 2,
  [ICT_MARKET_MAKER_STAGES.DISPLACEMENT]: 3,
  [ICT_MARKET_MAKER_STAGES.ACTIVE]: 4,
});

const finite = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function normalizeIctDirection(value) {
  const direction = String(value || '').toLowerCase();
  if (direction === 'bullish' || direction === 'buy' || direction === 'long') return 'bullish';
  if (direction === 'bearish' || direction === 'sell' || direction === 'short') return 'bearish';
  return null;
}

function completed(candles) {
  return Array.isArray(candles)
    ? candles.filter((candle) => candle && candle.complete !== false && [candle.open, candle.high, candle.low, candle.close].every((value) => Number.isFinite(Number(value))))
    : [];
}

function pivots(candles, side, span = 2) {
  const list = completed(candles);
  const out = [];
  for (let index = span; index < list.length - span; index += 1) {
    const value = Number(list[index][side]);
    const around = list.slice(index - span, index + span + 1);
    const isPivot = side === 'high'
      ? around.every((candle, offset) => offset === span || Number(candle.high) < value)
      : around.every((candle, offset) => offset === span || Number(candle.low) > value);
    if (isPivot) out.push({ price: value, time: list[index].time ?? null });
  }
  return out;
}

function pointCandidate({ source, timeframe, kind, price, formedAt, priority }) {
  if (!Number.isFinite(Number(price))) return null;
  const level = Number(price);
  return { source, timeframe, kind, level, zoneLow: level, zoneHigh: level, formedAt: formedAt ?? null, priority };
}

function zoneCandidate({ source, timeframe, kind, low, high, formedAt, priority }) {
  if (![low, high].every((value) => Number.isFinite(Number(value)))) return null;
  return {
    source, timeframe, kind,
    level: (Number(low) + Number(high)) / 2,
    zoneLow: Math.min(Number(low), Number(high)),
    zoneHigh: Math.max(Number(low), Number(high)),
    formedAt: formedAt ?? null,
    priority,
  };
}

/** Detect a recent touch of an aligned Daily/H4 swing, FVG, or order block. */
export function detectHtfKeyLevelTap({
  dailyCandles = [],
  h4Candles = [],
  m5Candles = [],
  direction,
  pair,
  atrPrice = null,
  touchLookbackBars = 72,
} = {}) {
  const wanted = normalizeIctDirection(direction);
  const blank = {
    tapped: false, aligned: false, direction: wanted, source: null, timeframe: null,
    kind: null, level: null, zoneLow: null, zoneHigh: null, formedAt: null, tappedAt: null,
  };
  if (!wanted) return blank;
  const daily = completed(dailyCandles);
  const h4 = completed(h4Candles);
  const m5 = completed(m5Candles).slice(-Math.max(12, Number(touchLookbackBars) || 72));
  if (!m5.length) return blank;

  const candidates = [];
  const latestDaily = daily.at(-1);
  if (wanted === 'bullish') {
    candidates.push(pointCandidate({ source: 'previous_day_low', timeframe: 'D1', kind: 'external_liquidity', price: latestDaily?.low, formedAt: latestDaily?.time, priority: 95 }));
  } else {
    candidates.push(pointCandidate({ source: 'previous_day_high', timeframe: 'D1', kind: 'external_liquidity', price: latestDaily?.high, formedAt: latestDaily?.time, priority: 95 }));
  }

  for (const timeframe of [
    { label: 'D1', candles: daily, priority: 90 },
    { label: 'H4', candles: h4, priority: 80 },
  ]) {
    const side = wanted === 'bullish' ? 'low' : 'high';
    for (const pivot of pivots(timeframe.candles.slice(-40), side).slice(-6)) {
      candidates.push(pointCandidate({
        source: `${timeframe.label.toLowerCase()}_swing_${side}`,
        timeframe: timeframe.label,
        kind: 'swing',
        price: pivot.price,
        formedAt: pivot.time,
        priority: timeframe.priority,
      }));
    }
    const fvgs = detectFVGs({ candles: timeframe.candles, pair, timeframe: timeframe.label, max: 8 });
    for (const fvg of fvgs.filter((item) => item.type === wanted && item.status !== 'filled')) {
      candidates.push(zoneCandidate({
        source: `${timeframe.label.toLowerCase()}_${wanted}_fvg`,
        timeframe: timeframe.label,
        kind: 'fvg',
        low: fvg.low,
        high: fvg.high,
        priority: timeframe.priority + 3,
      }));
    }
    const orderBlock = detectOrderBlock({ candles: timeframe.candles, pair });
    if (orderBlock?.type === wanted && orderBlock.mitigated !== true) {
      candidates.push(zoneCandidate({
        source: `${timeframe.label.toLowerCase()}_${wanted}_order_block`,
        timeframe: timeframe.label,
        kind: 'order_block',
        low: orderBlock.low,
        high: orderBlock.high,
        priority: timeframe.priority + 1,
      }));
    }
  }

  const tolerance = Math.max(finite(atrPrice, 0) * 0.12, String(pair || '').includes('JPY') ? 0.01 : 0.0001);
  const taps = [];
  for (const candidate of candidates.filter(Boolean)) {
    for (let index = m5.length - 1; index >= 0; index -= 1) {
      const candle = m5[index];
      const intersects = Number(candle.low) <= candidate.zoneHigh + tolerance &&
        Number(candle.high) >= candidate.zoneLow - tolerance;
      if (!intersects) continue;
      taps.push({ ...candidate, tappedAt: candle.time ?? null, recency: index });
      break;
    }
  }
  if (!taps.length) return blank;
  taps.sort((a, b) => b.recency - a.recency || b.priority - a.priority);
  const selected = taps[0];
  return {
    tapped: true,
    aligned: true,
    direction: wanted,
    source: selected.source,
    timeframe: selected.timeframe,
    kind: selected.kind,
    level: roundPrice(selected.level, pair),
    zoneLow: roundPrice(selected.zoneLow, pair),
    zoneHigh: roundPrice(selected.zoneHigh, pair),
    formedAt: selected.formedAt,
    tappedAt: selected.tappedAt,
  };
}

export function createIctMarketMakerCycle({ pair, direction, studyDate, studiedAt, powerOf3 = null } = {}) {
  return {
    version: 1,
    pair: String(pair || '').toUpperCase(),
    direction: normalizeIctDirection(direction),
    studyDate: studyDate || null,
    studiedAt: studiedAt || null,
    stage: ICT_MARKET_MAKER_STAGES.STUDIED,
    stageUpdatedAt: studiedAt || null,
    powerOf3: {
      accumulationObserved: true,
      asianRange: powerOf3?.asianRange ?? null,
      manipulationSide: null,
      distributionDirection: null,
    },
    keyLevel: null,
    manipulation: null,
    displacement: null,
    activationId: null,
    activatedAt: null,
  };
}

function stageRank(stage) {
  return STAGE_RANK[stage] ?? -1;
}

function eventTime(value, fallback) {
  return value?.time || value?.tappedAt || value?.candleTime || fallback || null;
}

function eventAtOrAfter(value, floor, fallback) {
  const eventMs = Date.parse(eventTime(value, fallback) || '');
  const floorMs = Date.parse(floor || '');
  return !Number.isFinite(eventMs) || !Number.isFinite(floorMs) || eventMs >= floorMs;
}

function stableToken(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9:._-]/g, '_');
}

function stageExpired(cycle, now, ttlMinutes) {
  if (!cycle || cycle.stage === ICT_MARKET_MAKER_STAGES.ACTIVE) return false;
  const updated = Date.parse(cycle.stageUpdatedAt || cycle.studiedAt || '');
  const current = Date.parse(now || '');
  return Number.isFinite(updated) && Number.isFinite(current) && current - updated > ttlMinutes * 60_000;
}

/** Pure reducer used by scans and the authoritative execution recompute. */
export function advanceIctMarketMakerCycle({
  context = null,
  observation = null,
  now = new Date(),
  stageTtlMinutes = finite(process.env.ICT_MARKET_MAKER_STAGE_TTL_MINUTES, 180),
} = {}) {
  const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
  const direction = normalizeIctDirection(observation?.direction);
  const studyReady = context?.studyReady === true && Boolean(context?.studyDate);
  const baseAuthorization = { ready: false, mode: 'none', cycleId: null, reason: null };
  if (!studyReady) {
    return {
      cycle: context?.cycle ?? null,
      changed: false,
      entryAuthorization: {
        ...baseAuthorization,
        reason: 'The required 02:00 ET ICT market study is not complete for the current New York trading day.',
      },
    };
  }
  if (!direction || observation?.htfAligned !== true) {
    return {
      cycle: context?.cycle ?? null,
      changed: false,
      entryAuthorization: {
        ...baseAuthorization,
        reason: 'Daily and H4 do not provide an aligned market-maker direction.',
      },
    };
  }

  let cycle = context?.cycle && typeof context.cycle === 'object'
    ? structuredClone(context.cycle)
    : createIctMarketMakerCycle({
      pair: observation?.pair,
      direction,
      studyDate: context.studyDate,
      studiedAt: context.studiedAt || timestamp,
      powerOf3: observation?.powerOf3,
    });
  let changed = !context?.cycle;
  const mustReset = cycle.studyDate !== context.studyDate ||
    normalizeIctDirection(cycle.direction) !== direction ||
    stageExpired(cycle, timestamp, Math.max(30, Number(stageTtlMinutes) || 180));
  if (mustReset) {
    cycle = createIctMarketMakerCycle({
      pair: observation?.pair,
      direction,
      studyDate: context.studyDate,
      studiedAt: context.studiedAt || timestamp,
      powerOf3: observation?.powerOf3,
    });
    changed = true;
  }

  const setStage = (stage, details = {}) => {
    if (stageRank(stage) <= stageRank(cycle.stage)) return;
    cycle.stage = stage;
    cycle.stageUpdatedAt = timestamp;
    Object.assign(cycle, details);
    changed = true;
  };

  if (stageRank(cycle.stage) === 0 && observation?.keyLevelTap?.aligned === true) {
    setStage(ICT_MARKET_MAKER_STAGES.KEY_TAPPED, {
      keyLevel: observation.keyLevelTap,
    });
  }
  if (
    stageRank(cycle.stage) >= 1 &&
    stageRank(cycle.stage) < 2 &&
    observation?.sweepAligned === true &&
    eventAtOrAfter(observation?.sweep, cycle.keyLevel?.tappedAt, timestamp)
  ) {
    setStage(ICT_MARKET_MAKER_STAGES.MANIPULATION, {
      manipulation: {
        direction,
        side: direction === 'bullish' ? 'sell-side' : 'buy-side',
        level: finite(observation?.sweep?.sweptPriceLevel),
        time: eventTime(observation?.sweep, timestamp),
      },
      powerOf3: {
        ...(cycle.powerOf3 || {}),
        manipulationSide: direction === 'bullish' ? 'sell-side' : 'buy-side',
      },
    });
  }
  if (
    stageRank(cycle.stage) >= 2 &&
    stageRank(cycle.stage) < 3 &&
    observation?.displacementFresh === true &&
    eventAtOrAfter(observation?.displacement, cycle.manipulation?.time, timestamp)
  ) {
    setStage(ICT_MARKET_MAKER_STAGES.DISPLACEMENT, {
      displacement: {
        direction,
        score: finite(observation?.displacement?.displacementScore),
        createdFVG: observation?.displacement?.createdFVG === true,
        time: eventTime(observation?.displacement, timestamp),
      },
    });
  }

  const ifvgAligned = observation?.inverseFvg?.confirmed === true && observation.inverseFvg.direction === direction;
  const cisdAligned = observation?.cisd?.confirmed === true && observation.cisd.direction === direction;
  const mssAligned = observation?.mssAligned === true;
  const pdArrayConfirmed = observation?.fvgAligned === true || observation?.displacement?.createdFVG === true || ifvgAligned;
  const distributionTrigger = pdArrayConfirmed && (mssAligned || ifvgAligned || cisdAligned);
  const distributionEvent = ifvgAligned
    ? observation.inverseFvg
    : cisdAligned
      ? observation.cisd
      : observation?.mss;
  const activatedThisScan = stageRank(cycle.stage) === 3 && distributionTrigger &&
    eventAtOrAfter(distributionEvent, cycle.displacement?.time, timestamp);
  if (activatedThisScan) {
    const anchor = cycle.keyLevel?.tappedAt || cycle.manipulation?.time || timestamp;
    const activationId = [
      context.studyDate,
      String(observation?.pair || cycle.pair || '').toUpperCase(),
      direction,
      stableToken(cycle.keyLevel?.source),
      stableToken(anchor),
    ].join(':');
    setStage(ICT_MARKET_MAKER_STAGES.ACTIVE, {
      activationId,
      activatedAt: timestamp,
      powerOf3: {
        ...(cycle.powerOf3 || {}),
        distributionDirection: direction,
      },
    });
  }

  const active = cycle.stage === ICT_MARKET_MAKER_STAGES.ACTIVE && Boolean(cycle.activationId);
  let entryAuthorization = {
    ...baseAuthorization,
    reason: `Market-maker cycle is ${cycle.stage}; waiting for the next required stage.`,
  };
  if (active && activatedThisScan) {
    const trigger = distributionEvent;
    const mode = ifvgAligned ? 'initial_reversal_ifvg' : cisdAligned ? 'initial_reversal_cisd' : 'initial_reversal_mss';
    entryAuthorization = {
      ready: true,
      mode,
      cycleId: `${cycle.activationId}:${mode}:${stableToken(eventTime(trigger, timestamp))}`,
      parentCycleId: cycle.activationId,
      reason: 'HTF key-level tap, liquidity manipulation, M5 displacement, and reversal confirmation activated distribution.',
    };
  } else if (active && observation?.h1Aligned === true) {
    const continuation = observation?.continuationBreakout;
    if (continuation?.ready === true && continuation?.cycleId) {
      entryAuthorization = {
        ready: true,
        mode: continuation.mode || 'm5_continuation_breakout',
        cycleId: `${cycle.activationId}:${continuation.cycleId}`,
        parentCycleId: cycle.activationId,
        reason: 'The activated market-maker distribution cycle authorized a fresh aligned M5 continuation entry.',
      };
    } else if (ifvgAligned || cisdAligned) {
      const trigger = ifvgAligned ? observation.inverseFvg : observation.cisd;
      const mode = ifvgAligned ? 'm5_continuation_ifvg' : 'm5_continuation_cisd';
      entryAuthorization = {
        ready: true,
        mode,
        cycleId: `${cycle.activationId}:${mode}:${stableToken(eventTime(trigger, timestamp))}`,
        parentCycleId: cycle.activationId,
        reason: `The activated market-maker distribution cycle authorized a fresh aligned ${ifvgAligned ? 'iFVG' : 'CISD'} continuation entry.`,
      };
    } else {
      entryAuthorization.reason = 'Distribution is active; waiting for a fresh M5 continuation BOS/retest, iFVG, or CISD confirmation.';
    }
  } else if (active) {
    entryAuthorization.reason = 'Distribution is active, but H1 no longer aligns with the Daily/H4 direction.';
  }

  return { cycle, changed, entryAuthorization };
}
