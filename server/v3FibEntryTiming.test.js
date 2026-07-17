import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveV3EntryTiming } from './v3EntryContract.js';
import { evaluateV3TriggerStage } from './v3QualityConfirmation.js';
import { deriveMarketMovementEntryTiming } from './v3MarketMovement.js';

function baseSignal({
  triggerType = 'confirmed_liquidity_sweep',
  triggerAgeBars = 1,
  triggerDistanceAtr = 0.2,
  pending = false,
  fibRetracement = 0.15,
} = {}) {
  const movement = {
    policyVersion: 'v3-market-movement-entry-v1-2026-07-17',
    pair: 'EUR_JPY',
    direction: 'long',
    currentPrice: 185.82,
    atrPips: 12,
    consolidating: false,
    events: pending ? [] : [{
      type: triggerType,
      direction: 'bullish',
      time: new Date(Date.now() - 15 * 60_000).toISOString(),
      triggerPrice: 185.79,
      confirmed: true,
    }],
    pendingEvents: pending ? [{
      type: 'pending_liquidity_sweep',
      direction: 'bullish',
      reason: 'Sell-side liquidity was pierced, but the close-back/reclaim is not confirmed.',
    }] : [],
    trigger: pending ? null : {
      type: triggerType,
      direction: 'bullish',
      time: new Date(Date.now() - 15 * 60_000).toISOString(),
      triggerPrice: 185.79,
      confirmed: true,
    },
    triggerConfirmed: !pending,
    triggerType: pending ? null : triggerType,
    triggerTime: pending ? null : new Date(Date.now() - 15 * 60_000).toISOString(),
    triggerPrice: pending ? null : 185.79,
    triggerAgeBars: pending ? null : triggerAgeBars,
    triggerDistancePips: pending ? null : triggerDistanceAtr * 12,
    triggerDistanceAtr: pending ? null : triggerDistanceAtr,
    maxTriggerBars: 3,
    maxDistanceAtr: 0.65,
    maxAdverseAtr: 0.25,
    fibUsedForConfirmation: false,
  };

  return {
    pair: 'EUR_JPY',
    direction: 'long',
    entry: 185.82,
    entryPrice: 185.82,
    stopLoss: 185.70,
    takeProfit: 186.06,
    expectedRR: 2,
    spreadPips: 1.4,
    score: 70,
    entryQualityConfidence: 80,
    v3: {
      pair: 'EUR_JPY',
      direction: 'long',
      score: 70,
      qualified: true,
      timeframes: { daily: 'bullish', h4: 'bullish', m15: 'bullish' },
      primaryTimeframeAlignment: {
        passed: true,
        score: 100,
        dailyH4Aligned: true,
        m15Aligned: true,
        expected: 'bullish',
      },
      fib: {
        enabled: true,
        timeframeUsed: 'H1',
        pctRetraced: fibRetracement,
        entryZoneStatus: fibRetracement < 0.382 ? 'too_early' : fibRetracement > 0.68 ? 'extended' : 'inside_zone',
        confirmationRole: 'diagnostic_only',
      },
      structure: {
        structureTrend: 'bullish',
        bosDetected: false,
        chochDetected: false,
      },
      liquidity: { liquiditySweepDetected: false, liquiditySweep: null },
      liquidityIntent: { liquidityBias: 'bullish', intentScore: 0.8 },
      sessionNarrative: { sessionBias: 'bullish' },
      volatility: { volatilityState: 'normal' },
      institutionalFlow: { signals: [] },
      marketMovement: movement,
      targets: { accepted: true },
    },
    institutionalFlow: { signals: [] },
  };
}

test('Fib retracement does not delay a fresh market-movement entry', () => {
  const fifteenPercent = baseSignal({ fibRetracement: 0.15 });
  const seventyPercent = baseSignal({ fibRetracement: 0.70 });

  const earlyFibTiming = deriveV3EntryTiming(fifteenPercent);
  const deepFibTiming = deriveV3EntryTiming(seventyPercent);

  assert.equal(earlyFibTiming.status, 'valid_entry');
  assert.equal(deepFibTiming.status, 'valid_entry');
  assert.equal(earlyFibTiming.timingSource, 'pair_market_movement');
  assert.equal(deepFibTiming.timingSource, 'pair_market_movement');
  assert.equal(earlyFibTiming.fibUsedForConfirmation, false);
  assert.equal(deepFibTiming.fibUsedForConfirmation, false);
});

test('a completed sweep is late when price has already moved too far from its entry event', () => {
  const signal = baseSignal({ triggerDistanceAtr: 0.9 });
  const timing = deriveV3EntryTiming(signal);

  assert.equal(timing.status, 'late_entry');
  assert.match(timing.reason, /do not chase/i);
  assert.equal(timing.triggerType, 'confirmed_liquidity_sweep');
});

test('a stale market trigger expires even when Fib would call the price favorable', () => {
  const signal = baseSignal({ triggerAgeBars: 4, fibRetracement: 0.5 });
  const timing = deriveV3EntryTiming(signal);

  assert.equal(timing.status, 'late_entry');
  assert.match(timing.reason, /execution window has passed/i);
  assert.equal(timing.fibUsedForConfirmation, false);
});

test('a pending liquidity event waits for close-back and reclaim rather than Fib', () => {
  const signal = baseSignal({ pending: true, fibRetracement: 0.5 });
  const timing = deriveV3EntryTiming(signal);

  assert.equal(timing.status, 'wait_for_retest');
  assert.match(timing.reason, /close-back|reclaim/i);
  assert.equal(timing.triggerConfirmed, false);
});

test('no market trigger remains too early regardless of Fib position', () => {
  const movement = {
    direction: 'long',
    events: [],
    pendingEvents: [],
    trigger: null,
    triggerConfirmed: false,
    maxTriggerBars: 3,
    maxDistanceAtr: 0.65,
    maxAdverseAtr: 0.25,
  };
  const timing = deriveMarketMovementEntryTiming({
    movement,
    alignment: { passed: true },
    sweepBlock: { allowed: true },
    reversal: { allowed: true },
  });

  assert.equal(timing.status, 'too_early');
  assert.match(timing.reason, /no fresh market-movement entry trigger/i);
});

test('Stage 2 becomes ready from a fresh movement trigger and non-Fib support', () => {
  const signal = baseSignal();
  signal.entryTiming = deriveV3EntryTiming(signal);
  signal.v3.entryTiming = signal.entryTiming;

  const stage2 = evaluateV3TriggerStage(signal);

  assert.equal(stage2.allowed, true, stage2.reasons.join('; '));
  assert.equal(stage2.state, 'ready');
  assert.deepEqual(stage2.primaryTriggers, ['confirmed_liquidity_sweep']);
  assert.ok(stage2.supports.includes('liquidity_intent_aligned'));
  assert.equal(stage2.supports.includes('favorable_premium_discount'), false);
  assert.equal(stage2.metrics.fibUsedForConfirmation, false);
});
