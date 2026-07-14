import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateV3SetupStage,
  evaluateV3TriggerStage,
  evaluateV3FreshExecutionStage,
} from './v3QualityConfirmation.js';
import { computeV3EntryTpHitConfidence } from './v3TpConfidence.js';

function retestSignal() {
  return {
    pair: 'EUR_USD',
    direction: 'long',
    entry: 1.10000,
    stopLoss: 1.09800,
    takeProfit: 1.10320,
    expectedRR: 1.6,
    spreadPips: 1.2,
    atrPips: 20,
    entryTiming: {
      status: 'valid_entry',
      retestDetected: true,
      retest: {
        type: 'retest',
        direction: 'bullish',
        timeframe: 'M15',
        level: 1.10000,
      },
    },
    qualityConfirmation: {
      checkedAt: new Date().toISOString(),
    },
    v3: {
      score: 72,
      direction: 'long',
      qualified: false,
      earlyTrigger: false,
      entryDistanceFromOriginPct: 0.42,
      targets: {
        accepted: true,
        tp1: { price: 1.10320 },
      },
      structure: {
        structureTrend: 'ranging',
        bosDetected: false,
        bos: null,
        chochDetected: false,
        choch: null,
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

test('confirmed retest contributes to entry TP-hit confidence', () => {
  const withRetest = retestSignal();
  const withoutRetest = structuredClone(withRetest);
  withoutRetest.entryTiming = { status: 'valid_entry', retestDetected: false, retest: null };

  const retestConfidence = computeV3EntryTpHitConfidence(withRetest);
  const baselineConfidence = computeV3EntryTpHitConfidence(withoutRetest);

  assert.equal(retestConfidence - baselineConfidence, 6);
  assert.ok(retestConfidence >= 85, `expected retest confidence >=85, got ${retestConfidence}`);
});

test('confirmed retest is a Stage 2 primary trigger', () => {
  const result = evaluateV3TriggerStage(retestSignal());

  assert.equal(result.allowed, true, result.reasons.join('; '));
  assert.ok(result.primaryTriggers.includes('confirmed_retest'));
  assert.equal(result.metrics.confirmedRetest, true);
});

test('confirmed retest can pass Stage 1 without an explicit confidence override', () => {
  const result = evaluateV3SetupStage(retestSignal());

  assert.equal(result.allowed, true, result.reasons.join('; '));
  assert.equal(result.metrics.confirmedRetest, true);
  assert.ok(result.metrics.tpHitConfidence >= 85);
});

test('confirmed retest remains valid through fresh execution checks', () => {
  const signal = retestSignal();
  const result = evaluateV3FreshExecutionStage(signal, {
    currentPrice: 1.10005,
    currentSpreadPips: 1.1,
    maxSpreadPips: 3.5,
    now: new Date(),
  });

  assert.equal(result.allowed, true, result.reasons.join('; '));
  assert.equal(result.metrics.confirmedRetest, true);
  assert.ok(result.metrics.tpHitConfidence >= result.metrics.minimumTpHitConfidence);
});
