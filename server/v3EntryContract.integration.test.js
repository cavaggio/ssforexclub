import test from 'node:test';
import assert from 'node:assert/strict';

import { buildIndependentV3Candidate } from './v3IndependentScanner.js';
import { evaluateV3SetupStage, evaluateV3TriggerStage } from './v3QualityConfirmation.js';
import { computeFixedDollarSizing } from './oandaRiskSizing.js';
import { evaluateUniversalEntryPolicy } from './executionPolicy.js';
import {
  buildOandaMarketOrderPayload,
  deriveV3EntryTiming,
  evaluateOpposingSweepBlock,
  repriceExecutableGeometry,
  validateDirectionLock,
} from './v3EntryContract.js';

function movementEvent({
  type = 'confirmed_liquidity_sweep',
  direction = 'bullish',
  time = '2026-07-16T12:20:00.000Z',
  triggerPrice = 1.1000,
} = {}) {
  return {
    type,
    direction,
    timeframe: 'M15',
    time,
    triggerPrice,
    confirmed: true,
    pending: false,
  };
}

function movementState({
  events = [movementEvent()],
  direction = 'long',
  trigger = events[events.length - 1] || null,
  triggerAgeBars = 1,
  triggerDistanceAtr = 0.2,
  pendingEvents = [],
} = {}) {
  return {
    policyVersion: 'v3-market-movement-entry-v1-2026-07-17',
    pair: 'EUR_USD',
    direction,
    currentPrice: 1.10005,
    atrPips: 20,
    consolidating: false,
    events,
    pendingEvents,
    trigger,
    triggerConfirmed: Boolean(trigger),
    triggerType: trigger?.type || null,
    triggerTime: trigger?.time || null,
    triggerPrice: trigger?.triggerPrice ?? null,
    triggerAgeBars: trigger ? triggerAgeBars : null,
    triggerDistancePips: trigger ? triggerDistanceAtr * 20 : null,
    triggerDistanceAtr: trigger ? triggerDistanceAtr : null,
    maxTriggerBars: 3,
    maxDistanceAtr: 0.65,
    maxAdverseAtr: 0.25,
    fibUsedForConfirmation: false,
  };
}

function generatedBullishV3(overrides = {}) {
  const v3 = {
    score: 78,
    qualified: true,
    direction: 'long',
    atrPips: 20,
    timeframes: { daily: 'bullish', h4: 'bullish', m15: 'bullish' },
    primaryTimeframeAlignment: {
      passed: true,
      score: 100,
      dailyH4Aligned: true,
      expected: 'bullish',
    },
    slPipsEst: 15,
    fib: {
      entryZoneStatus: 'inside_zone',
      confirmationRole: 'diagnostic_only',
    },
    fibConfirmationPolicy: 'diagnostic_only_not_used',
    targets: {
      accepted: true,
      tp1: { price: 1.1035, pips: 34.5, source: 'PDH' },
    },
    structure: {
      structureTrend: 'bullish',
      bosDetected: true,
      bos: { direction: 'bullish', time: '2026-07-16T12:10:00.000Z', brokenLevel: 1.0998 },
      chochDetected: false,
      choch: null,
    },
    liquidity: {
      liquiditySweepDetected: true,
      liquiditySweep: {
        type: 'liquidity_sweep',
        subtype: 'confirmed_sweep',
        direction: 'bullish',
        pending: false,
        time: '2026-07-16T12:20:00.000Z',
      },
    },
    liquidityIntent: { intentScore: 0.8, liquidityBias: 'bullish' },
    premiumDiscount: null,
    sessionNarrative: { sessionBias: 'bullish' },
    volatility: { volatilityState: 'normal', compressionDetected: false, expansionDetected: false },
    institutionalFlow: { signals: [] },
    marketMovement: movementState(),
    ...overrides,
  };
  return v3;
}

function generatedCandidate(v3 = generatedBullishV3()) {
  const candidate = buildIndependentV3Candidate({
    pair: 'EUR_USD',
    pricing: { instrument: 'EUR_USD', bid: 1.1000, ask: 1.1001, mid: 1.10005, spreadPips: 1 },
    v3,
    newsRisk: { blocked: false },
    session: { name: 'NewYork' },
    minRR: 1.5,
  });
  assert.ok(candidate, 'independent candidate should be generated');
  candidate.atrPips = 20;
  candidate.entryTiming = deriveV3EntryTiming(candidate);
  candidate.v3.entryTiming = candidate.entryTiming;
  return candidate;
}

test('generated independent V3 candidate passes Stage 1 and Stage 2, reprices from ask, sizes, and creates an order', () => {
  const candidate = generatedCandidate();
  const stage1 = evaluateV3SetupStage(candidate);
  assert.equal(stage1.allowed, true, stage1.reasons.join('; '));

  const stage2 = evaluateV3TriggerStage(candidate);
  assert.equal(stage2.allowed, true, stage2.reasons.join('; '));
  assert.equal(stage2.metrics.entryTiming.status, 'valid_entry');
  assert.equal(stage2.metrics.entryTiming.timingSource, 'pair_market_movement');
  assert.equal(stage2.metrics.entryTiming.fibUsedForConfirmation, false);
  assert.equal(stage2.metrics.alignment.dailyH4Aligned, true);

  candidate.qualityConfirmation = { stage1, stage2 };
  candidate.directionLock = {
    confirmedDirection: stage2.metrics.direction,
    freshDirection: stage2.metrics.direction,
  };

  const executable = repriceExecutableGeometry(candidate, {
    bid: 1.1000,
    ask: 1.1001,
    spreadPips: 1,
  }, {
    minRR: 1.5,
    maxSpreadPips: 3.5,
    maxPriceDriftAtr: 0.15,
  });

  assert.equal(executable.allowed, true, executable.reasons.join('; '));
  assert.equal(executable.entry, 1.1001);
  assert.equal(executable.priceSide, 'ask');

  const sizing = computeFixedDollarSizing({
    pair: candidate.pair,
    direction: candidate.direction,
    entryPrice: executable.entry,
    targetRiskUSD: 125,
    stopLossPips: executable.stopDistancePips,
    stopLossPrice: executable.stopLoss,
    takeProfitPips: executable.targetDistancePips,
    takeProfitPrice: executable.takeProfit,
    accountMarginRate: 0.02,
    accountBalanceUSD: 10000,
  });

  assert.ok(sizing.signedUnits > 0);
  assert.ok(sizing.riskReward >= 1.5);

  const payload = buildOandaMarketOrderPayload({
    pair: candidate.pair,
    signedUnits: sizing.signedUnits,
    stopLoss: sizing.stopLoss,
    takeProfit: sizing.takeProfit,
    priceDecimals: 5,
  });

  assert.equal(payload.order.instrument, 'EUR_USD');
  assert.ok(Number(payload.order.units) > 0);
  assert.equal(payload.order.type, 'MARKET');
  assert.equal(payload.order.stopLossOnFill.price, sizing.stopLoss.toFixed(5));
  assert.equal(payload.order.takeProfitOnFill.price, sizing.takeProfit.toFixed(5));
});

test('short execution geometry uses bid', () => {
  const geometry = repriceExecutableGeometry({
    pair: 'EUR_USD',
    direction: 'short',
    entry: 1.10005,
    stopLoss: 1.1016,
    takeProfit: 1.0970,
    atrPips: 20,
    maxSpreadPips: 3.5,
  }, {
    bid: 1.1000,
    ask: 1.1001,
    spreadPips: 1,
  });
  assert.equal(geometry.entry, 1.1000);
  assert.equal(geometry.priceSide, 'bid');
  assert.equal(geometry.allowed, true, geometry.reasons.join('; '));
});

test('confirmed opposing sweep cancels a long candidate', () => {
  const bearishSweep = movementEvent({
    direction: 'bearish',
    time: '2026-07-16T12:12:00.000Z',
    triggerPrice: 1.1002,
  });
  const v3 = generatedBullishV3({
    marketMovement: movementState({ events: [bearishSweep], trigger: bearishSweep }),
  });
  const candidate = generatedCandidate(v3);
  const sweepGate = evaluateOpposingSweepBlock(candidate, 'long');
  assert.equal(sweepGate.allowed, false);
  assert.match(sweepGate.reason, /opposes long/);
  assert.equal(candidate.entryTiming.status, 'invalidated');
  assert.equal(evaluateV3TriggerStage(candidate).allowed, false);
});

test('newer bullish CHoCH plus confirmed retest can override an older bearish sweep', () => {
  const bearishSweep = movementEvent({
    direction: 'bearish',
    time: '2026-07-16T12:05:00.000Z',
    triggerPrice: 1.0998,
  });
  const bullishRetest = movementEvent({
    type: 'confirmed_retest',
    direction: 'bullish',
    time: '2026-07-16T12:20:00.000Z',
    triggerPrice: 1.1000,
  });
  const v3 = generatedBullishV3({
    structure: {
      structureTrend: 'bearish',
      priorTrend: 'bearish',
      bosDetected: false,
      bos: null,
      chochDetected: true,
      choch: { direction: 'bullish', time: '2026-07-16T12:15:00.000Z', brokenLevel: 1.0999 },
    },
    marketMovement: movementState({
      events: [bearishSweep, bullishRetest],
      trigger: bullishRetest,
    }),
  });
  const candidate = generatedCandidate(v3);
  candidate.entryTiming = {
    ...deriveV3EntryTiming(candidate),
    status: 'valid_entry',
    retestDetected: true,
    retest: { direction: 'bullish', time: '2026-07-16T12:20:00.000Z' },
    triggerConfirmed: true,
    triggerType: 'confirmed_retest',
  };
  candidate.v3.entryTiming = candidate.entryTiming;
  const sweepGate = evaluateOpposingSweepBlock(candidate, 'long');
  assert.equal(sweepGate.allowed, true, sweepGate.reason);
  const stage2 = evaluateV3TriggerStage(candidate);
  assert.equal(stage2.allowed, true, stage2.reasons.join('; '));
  assert.equal(stage2.metrics.reversal.sequenceConfirmed, true);
});

test('direction lock rejects a freshly recalculated opposite side', () => {
  const lock = validateDirectionLock({
    candidateDirection: 'long',
    confirmedDirection: 'long',
    freshDirection: 'short',
  });
  assert.equal(lock.allowed, false);
  assert.match(lock.reasons.join(' '), /freshly recalculated direction short/);
});

test('V3 execution rejects a missing terminal entryTiming status', () => {
  const result = evaluateUniversalEntryPolicy({
    pair: 'EUR_USD',
    direction: 'long',
    engine: 'v3',
    v3: { direction: 'long', liquidity: {} },
  });
  assert.equal(result.v3Execution, true);
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join(' '), /entryTiming must be populated/);
});

test('ICT execution remains independent from V3 entryTiming states', () => {
  const result = evaluateUniversalEntryPolicy({
    pair: 'EUR_USD',
    direction: 'long',
    engine: 'ict',
    strategy: 'ICT',
    institutionalFlow: { detected: false, signals: [] },
  });
  assert.equal(result.v3Execution, false);
  assert.equal(result.allowed, true, result.reasons.join('; '));
  assert.doesNotMatch(result.reasons.join(' '), /entryTiming/);
});
