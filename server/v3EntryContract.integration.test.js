import test from 'node:test';
import assert from 'node:assert/strict';

import { buildIndependentV3Candidate } from './v3IndependentScanner.js';
import { evaluateV3SetupStage, evaluateV3TriggerStage } from './v3QualityConfirmation.js';
import { computeFixedDollarSizing } from './oandaRiskSizing.js';
import {
  buildOandaMarketOrderPayload,
  deriveV3EntryTiming,
  evaluateOpposingSweepBlock,
  repriceExecutableGeometry,
  validateDirectionLock,
} from './v3EntryContract.js';

function generatedBullishV3(overrides = {}) {
  const v3 = {
    score: 78,
    qualified: true,
    direction: 'long',
    timeframes: { daily: 'bullish', h4: 'bullish', m15: 'bullish' },
    primaryTimeframeAlignment: {
      passed: true,
      score: 100,
      dailyH4Aligned: true,
      expected: 'bullish',
    },
    entryDistanceFromOriginPct: 0.35,
    slPipsEst: 15,
    fib: { entryZoneStatus: 'inside_zone' },
    targets: {
      accepted: true,
      tp1: { price: 1.1035, pips: 34.5, source: 'PDH' },
    },
    structure: {
      structureTrend: 'bullish',
      bosDetected: true,
      bos: { direction: 'bullish', time: '2026-07-16T12:10:00.000Z' },
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
        time: '2026-07-16T12:05:00.000Z',
      },
    },
    liquidityIntent: { intentScore: 0.8, liquidityBias: 'bullish' },
    premiumDiscount: { premiumDiscountState: 'discount', premiumDiscountScore: 0.82 },
    sessionNarrative: { sessionBias: 'bullish' },
    volatility: { volatilityState: 'normal', compressionDetected: false, expansionDetected: false },
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
  return candidate;
}

test('generated independent V3 candidate passes Stage 1 and Stage 2, reprices from ask, sizes, and creates an order', () => {
  const candidate = generatedCandidate();
  const stage1 = evaluateV3SetupStage(candidate);
  assert.equal(stage1.allowed, true, stage1.reasons.join('; '));

  const stage2 = evaluateV3TriggerStage(candidate);
  assert.equal(stage2.allowed, true, stage2.reasons.join('; '));
  assert.equal(stage2.metrics.entryTiming.status, 'valid_entry');
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
  const v3 = generatedBullishV3({
    liquidity: {
      liquiditySweepDetected: true,
      liquiditySweep: {
        type: 'liquidity_sweep',
        subtype: 'confirmed_sweep',
        direction: 'bearish',
        pending: false,
        time: '2026-07-16T12:12:00.000Z',
      },
    },
  });
  const candidate = generatedCandidate(v3);
  const sweepGate = evaluateOpposingSweepBlock(candidate, 'long');
  assert.equal(sweepGate.allowed, false);
  assert.match(sweepGate.reason, /opposes long/);
  assert.equal(candidate.entryTiming.status, 'invalidated');
  assert.equal(evaluateV3TriggerStage(candidate).allowed, false);
});

test('newer bullish CHoCH plus confirmed retest can override an older bearish sweep', () => {
  const v3 = generatedBullishV3({
    structure: {
      structureTrend: 'bearish',
      priorTrend: 'bearish',
      bosDetected: false,
      bos: null,
      chochDetected: true,
      choch: { direction: 'bullish', time: '2026-07-16T12:15:00.000Z' },
    },
    liquidity: {
      liquiditySweepDetected: true,
      liquiditySweep: {
        type: 'liquidity_sweep',
        subtype: 'confirmed_sweep',
        direction: 'bearish',
        pending: false,
        time: '2026-07-16T12:05:00.000Z',
      },
    },
  });
  const candidate = generatedCandidate(v3);
  candidate.entryTiming = {
    ...deriveV3EntryTiming(candidate),
    status: 'valid_entry',
    retestDetected: true,
    retest: { direction: 'bullish', time: '2026-07-16T12:20:00.000Z' },
  };
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
