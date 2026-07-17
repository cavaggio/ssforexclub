import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectFibSetup,
  FIB_ENTRY_RETRACE_MIN,
  FIB_ENTRY_RETRACE_MAX,
} from './oandaFibonacci.js';
import { deriveV3EntryTiming } from './v3EntryContract.js';
import { evaluateV3TriggerStage } from './v3QualityConfirmation.js';

function candle(open, high, low, close, index) {
  return {
    open,
    high,
    low,
    close,
    time: new Date(1700000000000 + index * 3600000).toISOString(),
  };
}

function makeBullishH1() {
  const candles = [];
  for (let i = 0; i < 40; i++) {
    const center = 1.1000 + i * 0.00002;
    candles.push(candle(center, center + 0.0008, center - 0.0008, center + 0.0001, i));
  }
  candles[8] = candle(1.0920, 1.0930, 1.0900, 1.0925, 8);
  candles[15] = candle(1.1170, 1.1200, 1.1160, 1.1190, 15);
  return candles;
}

function signalAtRetracement(pctRetraced, pair = 'USD_JPY') {
  return {
    pair,
    direction: 'long',
    entryDistanceFromOriginPct: 0.85,
    v3: {
      pair,
      direction: 'long',
      score: 75,
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
        entryZoneStatus:
          pctRetraced < FIB_ENTRY_RETRACE_MIN
            ? 'too_early'
            : pctRetraced > FIB_ENTRY_RETRACE_MAX
              ? 'extended'
              : 'inside_zone',
        pctRetraced,
        entryZoneMinPct: FIB_ENTRY_RETRACE_MIN,
        entryZoneMaxPct: FIB_ENTRY_RETRACE_MAX,
      },
      structure: {
        structureTrend: 'bullish',
        bosDetected: true,
        bos: { direction: 'bullish', time: '2026-07-17T13:00:00.000Z' },
        chochDetected: false,
        choch: null,
      },
      liquidity: { liquiditySweepDetected: false, liquiditySweep: null },
      premiumDiscount: { premiumDiscountState: 'discount', premiumDiscountScore: 0.8 },
      liquidityIntent: { liquidityBias: 'bullish', intentScore: 0.8 },
      sessionNarrative: { sessionBias: 'bullish' },
      volatility: { volatilityState: 'normal' },
    },
    entryTiming: null,
    institutionalFlow: { signals: [] },
  };
}

test('H1 Fib entry zone is exactly 38.2% through 68%', () => {
  const tooEarly = detectFibSetup({
    direction: 'long',
    h1Candles: makeBullishH1(),
    currentPrice: 1.1155,
    pair: 'EUR_USD',
  });
  assert.equal(tooEarly.entryZoneStatus, 'too_early');
  assert.equal(tooEarly.entryEligible, false);
  assert.equal(tooEarly.entryZoneMinPct, 0.382);
  assert.equal(tooEarly.entryZoneMaxPct, 0.68);
  assert.equal(tooEarly.retracementLevels.level680, 1.0996);

  const inside = detectFibSetup({
    direction: 'long',
    h1Candles: makeBullishH1(),
    currentPrice: 1.1050,
    pair: 'EUR_USD',
  });
  assert.equal(inside.entryZoneStatus, 'inside_zone');
  assert.equal(inside.entryEligible, true);
  assert.equal(inside.pctRetraced, 0.5);

  const tooDeep = detectFibSetup({
    direction: 'long',
    h1Candles: makeBullishH1(),
    currentPrice: 1.0993,
    pair: 'EUR_USD',
  });
  assert.equal(tooDeep.entryZoneStatus, 'extended');
  assert.equal(tooDeep.entryEligible, false);
  assert.ok(tooDeep.pctRetraced > 0.68);
});

test('15% retraced is too early even when the old origin-distance value is 85%', () => {
  const signal = signalAtRetracement(0.15, 'USD_JPY');
  const timing = deriveV3EntryTiming(signal);

  assert.equal(timing.status, 'too_early');
  assert.equal(timing.fibRetracementPct, 15);
  assert.equal(timing.fibInEntryWindow, false);
  assert.equal(timing.timingSource, 'pair_h1_fibonacci_and_stage2_trigger');
  assert.doesNotMatch(timing.reason, /late|origin distance/i);
});

test('a pair becomes valid immediately when it enters its Fib window and has a Stage 2 trigger', () => {
  const signal = signalAtRetracement(0.5, 'EUR_CHF');
  signal.entryTiming = deriveV3EntryTiming(signal);

  assert.equal(signal.entryTiming.status, 'valid_entry');
  assert.equal(signal.entryTiming.fibInEntryWindow, true);

  const stage2 = evaluateV3TriggerStage(signal);
  assert.equal(stage2.allowed, true, stage2.reasons.join('; '));
  assert.equal(stage2.state, 'ready');
  assert.equal(stage2.metrics.fibRetracementPct, 50);
});

test('Stage 2 stays on watch while Fib is too early, even if BOS already exists', () => {
  const signal = signalAtRetracement(0.15, 'GBP_USD');
  signal.entryTiming = deriveV3EntryTiming(signal);

  const stage2 = evaluateV3TriggerStage(signal);
  assert.equal(stage2.allowed, false);
  assert.equal(stage2.state, 'watch');
  assert.equal(stage2.metrics.waitingForValidEntry, true);
  assert.equal(stage2.metrics.terminalEntryBlock, false);
  assert.ok(stage2.primaryTriggers.includes('fresh_aligned_bos'));
});

test('retracement beyond 68% is a terminal late-entry block for that pair', () => {
  const signal = signalAtRetracement(0.69, 'AUD_USD');
  signal.entryTiming = deriveV3EntryTiming(signal);

  assert.equal(signal.entryTiming.status, 'late_entry');
  const stage2 = evaluateV3TriggerStage(signal);
  assert.equal(stage2.allowed, false);
  assert.equal(stage2.state, 'blocked');
  assert.equal(stage2.metrics.terminalEntryBlock, true);
});
