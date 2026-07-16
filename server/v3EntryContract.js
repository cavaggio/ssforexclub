import { evaluatePrimaryTimeframeAlignment } from './primaryTimeframeAlignment.js';

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

function confirmedRetest(signal = {}, direction) {
  const sign = directionSign(direction);
  const timing = signal.entryTiming || extractV3(signal).entryTiming || {};
  const retest = timing.retest || signal.retest || null;
  const aligned = !retest?.direction || String(retest.direction).toLowerCase() === sign;
  return {
    confirmed: timing.retestDetected === true && aligned,
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

export function classifyPriceBias(candles = []) {
  if (!Array.isArray(candles) || candles.length < 20) return 'neutral';
  const recent = candles.slice(-20);
  const prior = recent.slice(0, 10);
  const current = recent.slice(10);
  const priorHigh = Math.max(...prior.map((c) => Number(c.high)));
  const priorLow = Math.min(...prior.map((c) => Number(c.low)));
  const currentHigh = Math.max(...current.map((c) => Number(c.high)));
  const currentLow = Math.min(...current.map((c) => Number(c.low)));
  const lastClose = Number(current[current.length - 1]?.close);
  const comparisonClose = Number(current[Math.max(0, current.length - 6)]?.close);
  const averageRange = recent.reduce((sum, candle) => {
    const high = Number(candle.high);
    const low = Number(candle.low);
    return sum + (Number.isFinite(high) && Number.isFinite(low) ? Math.abs(high - low) : 0);
  }, 0) / recent.length;
  const displacement = lastClose - comparisonClose;

  if (
    Number.isFinite(lastClose) &&
    currentHigh > priorHigh &&
    currentLow > priorLow &&
    displacement >= -(averageRange * 0.1)
  ) return 'bullish';

  if (
    Number.isFinite(lastClose) &&
    currentHigh < priorHigh &&
    currentLow < priorLow &&
    displacement <= averageRange * 0.1
  ) return 'bearish';

  if (Number.isFinite(displacement) && averageRange > 0) {
    if (displacement >= averageRange * 0.75) return 'bullish';
    if (displacement <= -(averageRange * 0.75)) return 'bearish';
  }

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
  const { choch, bos, structure } = structureEvents(signal, direction);
  const fibStatus = String(v3?.fib?.entryZoneStatus || signal?.fibonacci?.entryZoneStatus || '').toLowerCase();
  const entryDistance = numberOrNull(v3.entryDistanceFromOriginPct ?? signal.entryDistanceFromOriginPct);
  const maxEntryDistance = Number(process.env.V3_QUALITY_MAX_ENTRY_DISTANCE || 0.55);
  const liquidity = v3.liquidity || {};
  const sweep = liquidity.liquiditySweep || null;
  const pendingSweep = Boolean(
    liquidity.liquiditySweepDetected === true &&
    (sweep?.pending === true || String(sweep?.subtype || '').toLowerCase() === 'pending_sweep')
  );
  const marketState = String(
    v3?.marketRegime?.regime ||
    v3?.marketRegime?.state ||
    structure?.marketState ||
    structure?.structureTrend ||
    ''
  ).toLowerCase();
  const ranging = marketState.includes('rang') || marketState.includes('consolidat');

  let status = 'too_early';
  let reason = 'Stage 2 trigger has not completed yet';

  if (!direction || !alignment.passed) {
    status = 'invalidated';
    reason = alignment.reason || 'Daily/H4/M15 alignment is not executable';
  } else if (!sweepBlock.allowed) {
    status = 'invalidated';
    reason = sweepBlock.reason;
  } else if (fibStatus === 'invalidated') {
    status = 'invalidated';
    reason = 'price invalidated the V3 impulse origin';
  } else if (
    fibStatus === 'extended' ||
    (entryDistance !== null && Number.isFinite(maxEntryDistance) && entryDistance > maxEntryDistance)
  ) {
    status = 'late_entry';
    reason = 'price has moved beyond the permitted V3 entry distance';
  } else if (pendingSweep || fibStatus === 'too_early') {
    status = 'too_early';
    reason = pendingSweep
      ? 'liquidity sweep is still pending confirmation'
      : 'price has not reached the permitted entry area';
  } else if (!reversal.allowed) {
    status = 'wait_for_retest';
    reason = reversal.reason;
  } else if (ranging && !retest.confirmed) {
    status = 'wait_for_retest';
    reason = 'range breakout requires a confirmed retest';
  } else if (choch && !retest.confirmed && !reversal.alignedSweep) {
    status = 'wait_for_retest';
    reason = 'CHoCH is confirmed, but the sweep/retest sequence is incomplete';
  } else if (
    retest.confirmed ||
    reversal.alignedSweep ||
    bos ||
    (choch && reversal.sequenceConfirmed)
  ) {
    status = 'valid_entry';
    reason = 'Daily/H4 alignment and Stage 2 entry sequence are confirmed';
  }

  return {
    status,
    reason,
    retestDetected: retest.confirmed,
    retest: retest.retest || null,
    alignmentScore: alignment.score,
    dailyH4Aligned: alignment.dailyH4Aligned === true,
    opposingSweepBlocked: !sweepBlock.allowed,
    reversalSequenceConfirmed: reversal.sequenceConfirmed,
    checkedAt: new Date().toISOString(),
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
