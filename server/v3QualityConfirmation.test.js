import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateV3SetupStage,
  evaluateV3TriggerStage,
  evaluateV3FreshExecutionStage,
} from './v3QualityConfirmation.js';

function baseSignal() {
  return {
    pair: 'EUR_USD',
    direction: 'long',
    confidence: 86,
    score: 72,
    entry: 1.10000,
    stopLoss: 1.09800,
    takeProfit: 1.10320,
    expectedRR: 1.6,
    spreadPips: 1.2,
    atrPips: 20,
    qualityConfirmation: {
      checkedAt: new Date().toISOString(),
    },
    institutionalFlow: {
      signals: [{ type: 'retest', direction: 'bullish' }],
    },
    v3: {
      score: 72,
      direction: 'long',
      entryDistanceFromOriginPct: 0.42,
      targets: {
        accepted: true,
        tp1: { price: 1.10320 },
      },
      structure: {
        structureTrend: 'bullish',
        bosDetected: true,
        bos: { direction: 'bullish' },
        chochDetected: false,
      },
      liquidity: {
        liquiditySweepDetected: false,
        liquiditySweep: null,
      },
      liquidityIntent: {
        intentScore: 0.72,
        liquidityBias: 'bullish',
      },
      premiumDiscount: {
        premiumDiscountState: 'discount',
        premiumDiscountScore: 0.8,
      },
      sessionNarrative: {
        sessionBias: 'bullish',
      },
      volatility: {
        volatilityState: 'normal',
        compressionDetected: false,
        expansionDetected: false,
      },
    },
  };
}

test('Stage 1 accepts a valid setup for watch state', () => {
  const signal = baseSignal();
  signal.tpHitConfidence = 90;
  const result = evaluateV3SetupStage(signal);
  assert.equal(result.allowed, true);
  assert.equal(result.state, 'watch');
});

test('Stage 1 accepts a V3 score of exactly 62', () => {
  const signal = baseSignal();
  signal.score = 62;
  signal.v3.score = 62;
  signal.tpHitConfidence = 90;

  const result = evaluateV3SetupStage(signal);
  assert.equal(result.metrics.minScore, 62);
  assert.equal(result.allowed, true, result.reasons.join('; '));
});

test('Stage 1 rejects a V3 score below 62', () => {
  const signal = baseSignal();
  signal.score = 61;
  signal.v3.score = 61;
  signal.tpHitConfidence = 90;

  const result = evaluateV3SetupStage(signal);
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join(' '), /V3 score 61 < 62/);
});

test('Stage 1 treats internal V3 structure opposition as diagnostic only', () => {
  const signal = baseSignal();
  signal.tpHitConfidence = 90;
  signal.v3.structure.structureTrend = 'bearish';
  signal.v3.structure.chochDetected = false;
  signal.v3.structure.choch = null;

  const result = evaluateV3SetupStage(signal);
  assert.equal(result.metrics.opposingStructure, true);
  assert.equal(result.metrics.opposingStructurePolicy, 'diagnostic_only');
  assert.equal(result.allowed, true, result.reasons.join('; '));
  assert.doesNotMatch(result.reasons.join(' '), /structure opposes direction/i);
});

test('Stage 1 rejects R:R below 1.5', () => {
  const signal = baseSignal();
  signal.tpHitConfidence = 90;
  signal.takeProfit = 1.10200;
  signal.expectedRR = 1;
  signal.v3.targets.tp1.price = 1.10200;
  const result = evaluateV3SetupStage(signal);
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join(' '), /R:R/);
});

test('Stage 2 accepts aligned BOS with one supporting confirmation', () => {
  const result = evaluateV3TriggerStage(baseSignal());
  assert.equal(result.allowed, true);
  assert.ok(result.primaryTriggers.includes('fresh_aligned_bos'));
  assert.ok(result.supports.length >= 1);
});

test('Stage 2 blocks a pending sweep', () => {
  const signal = baseSignal();
  signal.v3.structure.bosDetected = false;
  signal.v3.structure.bos = null;
  signal.v3.liquidity = {
    liquiditySweepDetected: true,
    liquiditySweep: {
      subtype: 'pending_sweep',
      pending: true,
      direction: 'bullish',
    },
  };
  const result = evaluateV3TriggerStage(signal);
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join(' '), /pending/);
});

test('Compressed market alone remains watch-only', () => {
  const signal = baseSignal();
  signal.v3.structure.bosDetected = false;
  signal.v3.structure.bos = null;
  signal.v3.volatility = {
    volatilityState: 'compressed',
    compressionDetected: true,
    expansionDetected: false,
  };
  const result = evaluateV3TriggerStage(signal);
  assert.equal(result.allowed, false);
  assert.equal(result.state, 'watch');
});

test('Stage 3 accepts a fresh, low-drift executable price', () => {
  const signal = baseSignal();
  const result = evaluateV3FreshExecutionStage(signal, {
    currentPrice: 1.10005,
    currentSpreadPips: 1.1,
    maxSpreadPips: 3.5,
    now: new Date(),
  });
  assert.equal(result.allowed, true, result.reasons.join('; '));
});

test('Stage 3 does not penalize internal V3 structure opposition', () => {
  const signal = baseSignal();
  signal.v3.structure.structureTrend = 'bearish';
  const result = evaluateV3FreshExecutionStage(signal, {
    currentPrice: 1.10005,
    currentSpreadPips: 1.1,
    maxSpreadPips: 3.5,
    now: new Date(),
  });
  assert.equal(result.allowed, true, result.reasons.join('; '));
});

test('Stage 3 rejects stale confirmation', () => {
  const signal = baseSignal();
  signal.qualityConfirmation.checkedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const result = evaluateV3FreshExecutionStage(signal, {
    currentPrice: 1.10005,
    currentSpreadPips: 1.1,
    maxSpreadPips: 3.5,
    now: new Date(),
  });
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join(' '), /signal age/);
});

test('Stage 3 rejects excessive price drift', () => {
  const signal = baseSignal();
  const result = evaluateV3FreshExecutionStage(signal, {
    currentPrice: 1.10040,
    currentSpreadPips: 1.1,
    maxSpreadPips: 3.5,
    now: new Date(),
  });
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join(' '), /price drift/);
});
