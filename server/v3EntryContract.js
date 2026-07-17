import { evaluatePrimaryTimeframeAlignment } from './primaryTimeframeAlignment.js';
import { deriveMarketMovementEntryTiming } from './v3MarketMovement.js';

export const ENTRY_TIMING_STATUSES = Object.freeze([
  'valid_entry',
  'too_early',
  'wait_for_retest',
  'late_entry',
  'invalidated',
]);

const ENTRY_TIMING_SET = new Set(ENTRY_TIMING_STATUSES);

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeDirection(value) {
  const direction = String(value || '').trim().toLowerCase();
  if (direction === 'buy' || direction === 'bullish') return 'long';
  if (direction === 'sell' || direction === 'bearish') return 'short';
  return direction === 'long' || direction === 'short' ? direction : null;
}

function directionSign(direction) {
  const normalized = normalizeDirection(direction);
  return normalized === 'long' ? 'bullish' : normalized === 'short' ? 'bearish' : null;
}

function extractV3(signal = {}) {
  return signal.v3 || signal.v3Eval || signal.v3Analysis || signal.metadata?.v3 || signal;
}

function eventTimestamp(event = {}) {
  if (!event || typeof event !== 'object') return null;
  const raw = event.time || event.timestamp || event.candleTime || event.detectedAt || null;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function pipSizeFor(pair = '') {
  if (String(pair).includes('JPY')) return 0.01;
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return 0.01;
  return 0.0001;
}

function priceDecimalsFor(pair = '') {
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return 2;
  return String(pair).includes('JPY') ? 3 : 5;
}

function marketMovementEvents(signal = {}) {
  const v3 = extractV3(signal);
  return Array.isArray(v3?.marketMovement?.events) ? v3.marketMovement.events : [];
}

function confirmedRetest(signal = {}, direction) {
  const sign = directionSign(direction);
  const timing = signal.entryTiming || extractV3(signal).entryTiming || {};
  const movementRetest = marketMovementEvents(signal)
    .filter((event) => event?.type === 'confirmed_retest')
    .filter((event) => !event?.direction || String(event.direction).toLowerCase() === sign)
    .sort((left, right) => (eventTimestamp(left) ?? 0) - (eventTimestamp(right) ?? 0))
    .at(-1) || null;
  const flowSignals = Array.isArray(signal?.institutionalFlow?.signals)
    ? signal.institutionalFlow.signals
    : Array.isArray(extractV3(signal)?.institutionalFlow?.signals)
      ? extractV3(signal).institutionalFlow.signals
      : [];
  const flowRetest = flowSignals
    .filter((event) => String(event?.type || '').toLowerCase() === 'retest')
    .filter((event) => !event?.direction || String(event.direction).toLowerCase() === sign)
    .sort((left, right) => (eventTimestamp(left) ?? 0) - (eventTimestamp(right) ?? 0))
    .at(-1) || null;
  const retest = movementRetest || flowRetest || timing.retest || signal.retest || null;
  const aligned = !retest?.direction || String(retest.direction).toLowerCase() === sign;
  const confirmed = Boolean(
    aligned && (
      movementRetest ||
      flowRetest ||
      timing.retestDetected === true
    )
  );
  return {
    confirmed,
    retest,
    time: eventTimestamp(retest) || eventTimestamp(timing.triggerCandle),
  };
}

function structureEvents(signal = {}, direction) {
  const v3 = extractV3(signal);
  const structure = v3.structure || signal.structure || {};
  const sign = directionSign(direction);
  const choch = structure.chochDetected === true && structure.choch?.direction === sign
    ? structure.choch
    : null;
  const bos = structure.bosDetected === true && structure.bos?.direction === sign
    ? structure.bos
    : null;
  return { structure, choch, bos };
}

function confirmedSweeps(signal = {}) {
  const v3 = extractV3(signal);
  const movementEvents = marketMovementEvents(signal)
    .filter((item) => item?.type === 'confirmed_liquidity_sweep');

  // When the native market-movement engine is present, it is authoritative.
  // This prevents the older rolling five-candle sweep detector from repeatedly
  // presenting a completed sweep as if it were a new event on every scan.
  if (v3?.marketMovement) {
    return movementEvents
      .map((item) => ({ ...item, _eventTime: eventTimestamp(item) }))
      .sort((a, b) => (a._eventTime ?? 0) - (b._eventTime ?? 0));
  }

  const liquiditySweep = v3?.liquidity?.liquiditySweep || signal?.liquiditySweep || null;
  const flowSignals = Array.isArray(signal?.institutionalFlow?.signals)
    ? signal.institutionalFlow.signals
    : [];
  const sweeps = [liquiditySweep, ...flowSignals.filter((item) => item?.type === 'liquidity_sweep')]
    .filter(Boolean)
    .filter((item) => item.pending !== true)
    .filter((item) => String(item.subtype || 'confirmed_sweep').toLowerCase() !== 'pending_sweep')
    .map((item) => ({ ...item, _eventTime: eventTimestamp(item) }));

  return sweeps.sort((a, b) => (a._eventTime ?? 0) - (b._eventTime ?? 0));
}

export const V3_PRICE_BIAS_POLICY_VERSION = 'v3-price-action-trend-v2-2026-07-17';

function finitePriceCandle(candle = {}) {
  const open = Number(candle.open);
  const high = Number(candle.high);
  const low = Number(candle.low);
  const close = Number(candle.close);
  if (![open, high, low, close].every(Number.isFinite)) return null;
  if (high < low) return null;
  return { ...candle, open, high, low, close };
}

function average(values = []) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function regressionSlope(values = []) {
  if (values.length < 2) return 0;
  const xMean = (values.length - 1) / 2;
  const yMean = average(values);
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index += 1) {
    const xDelta = index - xMean;
    numerator += xDelta * (values[index] - yMean);
    denominator += xDelta * xDelta;
  }
  return denominator > 0 ? numerator / denominator : 0;
}

/** Native V3 price-action classifier. No legacy indicators are used. */
export function classifyPriceBias(candles = []) {
  if (!Array.isArray(candles)) return 'neutral';
  const valid = candles.map(finitePriceCandle).filter(Boolean);
  if (valid.length < 20) return 'neutral';

  const recent = valid.slice(-Math.min(30, valid.length));
  const closes = recent.map((candle) => candle.close);
  const ranges = recent.map((candle) => Math.max(0, candle.high - candle.low));
  const averageRange = average(ranges.filter((value) => value > 0));
  if (!Number.isFinite(averageRange) || averageRange <= 0) return 'neutral';

  const sample = Math.max(4, Math.floor(recent.length / 5));
  const firstCloseMean = average(closes.slice(0, sample));
  const lastCloseMean = average(closes.slice(-sample));
  const netChange = closes.at(-1) - closes[0];
  const rollingShift = lastCloseMean - firstCloseMean;
  const projectedSlope = regressionSlope(closes) * (closes.length - 1);

  const split = Math.floor(recent.length / 2);
  const prior = recent.slice(0, split);
  const current = recent.slice(split);
  const priorHigh = Math.max(...prior.map((candle) => candle.high));
  const priorLow = Math.min(...prior.map((candle) => candle.low));
  const currentHigh = Math.max(...current.map((candle) => candle.high));
  const currentLow = Math.min(...current.map((candle) => candle.low));
  const structureBuffer = averageRange * 0.05;
  const bullishStructure = currentHigh > priorHigh + structureBuffer && currentLow > priorLow + structureBuffer;
  const bearishStructure = currentHigh < priorHigh - structureBuffer && currentLow < priorLow - structureBuffer;

  const windowHigh = Math.max(...recent.map((candle) => candle.high));
  const windowLow = Math.min(...recent.map((candle) => candle.low));
  const windowRange = windowHigh - windowLow;
  const closeLocation = windowRange > 0 ? (closes.at(-1) - windowLow) / windowRange : 0.5;

  let bullishVotes = 0;
  let bearishVotes = 0;
  if (netChange >= averageRange * 0.4) bullishVotes += 1;
  if (netChange <= -averageRange * 0.4) bearishVotes += 1;
  if (rollingShift >= averageRange * 0.3) bullishVotes += 1;
  if (rollingShift <= -averageRange * 0.3) bearishVotes += 1;
  if (projectedSlope >= averageRange * 0.4) bullishVotes += 1;
  if (projectedSlope <= -averageRange * 0.4) bearishVotes += 1;
  if (bullishStructure) bullishVotes += 1;
  if (bearishStructure) bearishVotes += 1;
  if (closeLocation >= 0.6) bullishVotes += 1;
  if (closeLocation <= 0.4) bearishVotes += 1;

  if (bullishVotes >= 3 && bullishVotes > bearishVotes) return 'bullish';
  if (bearishVotes >= 3 && bearishVotes > bullishVotes) return 'bearish';
  return 'neutral';
}

export function derivePrimaryTimeframes({ dailyCandles = [], h4Candles = [], m15Candles = [] } = {}) {
  return {
    daily: classifyPriceBias(dailyCandles),
    h4: classifyPriceBias(h4Candles),
    m15: classifyPriceBias(m15Candles),
  };
}

export function directionFromDailyH4(timeframes = {}) {
  const daily = String(timeframes.daily || '').toLowerCase();
  const h4 = String(timeframes.h4 || '').toLowerCase();
  if (daily !== h4) return null;
  if (daily === 'bullish') return 'long';
  if (daily === 'bearish') return 'short';
  return null;
}

export function evaluateOpposingSweepBlock(signal = {}, direction = null) {
  const intendedDirection = normalizeDirection(direction || signal.direction || extractV3(signal).direction);
  const sign = directionSign(intendedDirection);
  const sweeps = confirmedSweeps(signal);
  const latestSweep = sweeps.length ? sweeps[sweeps.length - 1] : null;

  if (!latestSweep || !sign || latestSweep.direction === sign) {
    return {
      allowed: true,
      opposingSweep: false,
      latestSweep,
      reversalOverride: false,
      reason: null,
    };
  }

  const { choch } = structureEvents(signal, intendedDirection);
  const retest = confirmedRetest(signal, intendedDirection);
  const sweepTime = latestSweep._eventTime;
  const chochTime = eventTimestamp(choch);
  const newerAlignedChoch = Boolean(
    choch &&
    sweepTime !== null &&
    chochTime !== null &&
    chochTime > sweepTime
  );
  const reversalOverride = newerAlignedChoch && retest.confirmed;

  return {
    allowed: reversalOverride,
    opposingSweep: true,
    latestSweep,
    newerAlignedChoch,
    confirmedRetest: retest.confirmed,
    reversalOverride,
    reason: reversalOverride
      ? null
      : `confirmed ${latestSweep.direction} liquidity sweep opposes ${intendedDirection}; ` +
        'a newer aligned CHoCH plus confirmed retest is required',
  };
}

export function evaluateReversalSequence(signal = {}, direction = null) {
  const intendedDirection = normalizeDirection(direction || signal.direction || extractV3(signal).direction);
  const { choch, structure } = structureEvents(signal, intendedDirection);
  const retest = confirmedRetest(signal, intendedDirection);
  const sign = directionSign(intendedDirection);
  const alignedSweep = confirmedSweeps(signal).filter((sweep) => sweep.direction === sign).at(-1) || null;
  const priorTrend = String(structure.priorTrend || structure.previousTrend || '').toLowerCase();
  const explicitReversal = Boolean(
    choch ||
    structure.reversalDetected === true ||
    (priorTrend && priorTrend !== sign && priorTrend !== 'ranging')
  );
  const sequenceConfirmed = Boolean(choch && (retest.confirmed || alignedSweep));

  return {
    reversal: explicitReversal,
    allowed: !explicitReversal || sequenceConfirmed,
    choch,
    confirmedRetest: retest.confirmed,
    alignedSweep,
    sequenceConfirmed,
    reason: !explicitReversal || sequenceConfirmed
      ? null
      : 'reversal entry requires an aligned confirmed CHoCH plus a confirmed sweep or retest sequence',
  };
}

export function deriveV3EntryTiming(signal = {}) {
  const v3 = extractV3(signal);
  const direction = normalizeDirection(signal.direction || v3.direction);
  const alignment = evaluatePrimaryTimeframeAlignment(v3, direction);
  const sweepBlock = evaluateOpposingSweepBlock(signal, direction);
  const reversal = evaluateReversalSequence(signal, direction);
  const retest = confirmedRetest(signal, direction);
  const movement = v3?.marketMovement || signal?.marketMovement || null;
  const marketTiming = deriveMarketMovementEntryTiming({
    movement,
    alignment,
    sweepBlock,
    reversal,
  });

  return {
    ...marketTiming,
    retestDetected: retest.confirmed,
    retest: retest.retest || null,
    alignmentScore: alignment.score,
    dailyH4Aligned: alignment.dailyH4Aligned === true,
    opposingSweepBlocked: !sweepBlock.allowed,
    reversalSequenceConfirmed: reversal.sequenceConfirmed,
    fibUsedForConfirmation: false,
  };
}

export function evaluateStage2EntryContract(signal = {}) {
  const v3 = extractV3(signal);
  const direction = normalizeDirection(signal.direction || v3.direction);
  const alignment = evaluatePrimaryTimeframeAlignment(v3, direction);
  const entryTiming = signal.entryTiming || v3.entryTiming || deriveV3EntryTiming(signal);
  const sweepBlock = evaluateOpposingSweepBlock({ ...signal, entryTiming }, direction);
  const reversal = evaluateReversalSequence({ ...signal, entryTiming }, direction);
  const reasons = [];

  if (!direction) reasons.push('missing executable direction');
  if (!alignment.passed) reasons.push(alignment.reason);
  if (!ENTRY_TIMING_SET.has(entryTiming?.status)) {
    reasons.push('entryTiming is missing a recognized terminal status');
  } else if (entryTiming.status !== 'valid_entry') {
    reasons.push(`entry timing ${entryTiming.status} is not executable: ${entryTiming.reason || 'no reason provided'}`);
  }
  if (!sweepBlock.allowed) reasons.push(sweepBlock.reason);
  if (!reversal.allowed) reasons.push(reversal.reason);

  return {
    allowed: reasons.length === 0,
    reasons,
    direction,
    lockedDirection: direction,
    alignment,
    entryTiming,
    sweepBlock,
    reversal,
  };
}

export function validateDirectionLock({ candidateDirection, confirmedDirection, freshDirection } = {}) {
  const candidate = normalizeDirection(candidateDirection);
  const confirmed = normalizeDirection(confirmedDirection);
  const fresh = normalizeDirection(freshDirection);
  const reasons = [];

  if (!candidate || !confirmed || !fresh) reasons.push('direction lock is incomplete');
  if (candidate && confirmed && candidate !== confirmed) {
    reasons.push(`candidate direction ${candidate} differs from Stage 2 direction ${confirmed}`);
  }
  if (candidate && fresh && candidate !== fresh) {
    reasons.push(`freshly recalculated direction ${fresh} differs from candidate direction ${candidate}`);
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    candidateDirection: candidate,
    confirmedDirection: confirmed,
    freshDirection: fresh,
  };
}

export function selectExecutablePrice(direction, pricing = {}) {
  const normalized = normalizeDirection(direction);
  const ask = numberOrNull(pricing.ask ?? pricing.closeoutAsk);
  const bid = numberOrNull(pricing.bid ?? pricing.closeoutBid);
  if (normalized === 'long') return ask;
  if (normalized === 'short') return bid;
  return null;
}

export function repriceExecutableGeometry(candidate = {}, pricing = {}, options = {}) {
  const direction = normalizeDirection(candidate.direction);
  const pair = candidate.pair || candidate.instrument || '';
  const entry = selectExecutablePrice(direction, pricing);
  const sourceEntry = numberOrNull(candidate.entry ?? candidate.entryPrice ?? candidate.currentPrice);
  const stopLoss = numberOrNull(candidate.stopLoss ?? candidate.sl ?? candidate.lifecycle?.sl?.stopLossPrice);
  const takeProfit = numberOrNull(candidate.takeProfit ?? candidate.targetProfit ?? candidate.tp ?? candidate.lifecycle?.tp?.takeProfitPrice);
  const pipSize = pipSizeFor(pair);
  const spreadPips = numberOrNull(
    pricing.spreadPips ??
    (numberOrNull(pricing.ask) !== null && numberOrNull(pricing.bid) !== null
      ? (Number(pricing.ask) - Number(pricing.bid)) / pipSize
      : null)
  );
  const atrPips = numberOrNull(candidate.atrPips ?? candidate.momentum?.atrPips ?? candidate.v3?.atrPips);
  const driftPips = entry !== null && sourceEntry !== null ? Math.abs(entry - sourceEntry) / pipSize : null;
  const driftAtr = driftPips !== null && atrPips !== null && atrPips > 0 ? driftPips / atrPips : null;
  const stopDistancePips = entry !== null && stopLoss !== null ? Math.abs(entry - stopLoss) / pipSize : null;
  const targetDistancePips = entry !== null && takeProfit !== null ? Math.abs(takeProfit - entry) / pipSize : null;
  const geometryValid = Boolean(
    direction &&
    entry !== null &&
    stopLoss !== null &&
    takeProfit !== null &&
    stopDistancePips > 0 &&
    targetDistancePips > 0 &&
    (
      (direction === 'long' && stopLoss < entry && takeProfit > entry) ||
      (direction === 'short' && stopLoss > entry && takeProfit < entry)
    )
  );
  const riskReward = geometryValid ? targetDistancePips / stopDistancePips : null;
  const minRR = Number(options.minRR ?? process.env.FOREX_MIN_EXECUTABLE_RR ?? 1.5);
  const maxSpreadPips = numberOrNull(options.maxSpreadPips ?? candidate.maxSpreadPips);
  const maxPriceDriftAtr = Number(options.maxPriceDriftAtr ?? process.env.V3_QUALITY_MAX_PRICE_DRIFT_ATR ?? 0.15);
  const reasons = [];

  if (entry === null) reasons.push(`executable ${direction === 'long' ? 'ask' : 'bid'} price unavailable`);
  if (!geometryValid) reasons.push('executable stop/target geometry is invalid');
  if (!Number.isFinite(riskReward) || riskReward < minRR) {
    reasons.push(`executable R:R ${Number.isFinite(riskReward) ? riskReward.toFixed(3) : 'n/a'} < ${minRR}`);
  }
  if (maxSpreadPips !== null && spreadPips !== null && spreadPips > maxSpreadPips) {
    reasons.push(`fresh spread ${spreadPips.toFixed(2)} > ${maxSpreadPips}`);
  }
  if (driftAtr !== null && Number.isFinite(maxPriceDriftAtr) && driftAtr > maxPriceDriftAtr) {
    reasons.push(`entry drift ${driftAtr.toFixed(3)} ATR > ${maxPriceDriftAtr} ATR`);
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    direction,
    entry,
    sourceEntry,
    stopLoss,
    takeProfit,
    spreadPips,
    driftPips,
    driftAtr,
    stopDistancePips,
    targetDistancePips,
    riskReward: Number.isFinite(riskReward) ? Number(riskReward.toFixed(3)) : null,
    priceSide: direction === 'long' ? 'ask' : direction === 'short' ? 'bid' : null,
  };
}

export function buildOandaMarketOrderPayload({
  pair,
  signedUnits,
  stopLoss,
  takeProfit,
  priceDecimals = priceDecimalsFor(pair),
} = {}) {
  const units = Number(signedUnits);
  const sl = numberOrNull(stopLoss);
  const tp = numberOrNull(takeProfit);
  if (!pair || !Number.isFinite(units) || units === 0 || sl === null || tp === null) {
    throw new Error('invalid OANDA market-order inputs');
  }

  return {
    order: {
      type: 'MARKET',
      instrument: pair,
      units: units.toString(),
      timeInForce: 'IOC',
      positionFill: 'DEFAULT',
      stopLossOnFill: { price: sl.toFixed(priceDecimals), timeInForce: 'GTC' },
      takeProfitOnFill: { price: tp.toFixed(priceDecimals), timeInForce: 'GTC' },
    },
  };
}

export const _test = {
  normalizeDirection,
  directionSign,
  confirmedSweeps,
  confirmedRetest,
  eventTimestamp,
};
