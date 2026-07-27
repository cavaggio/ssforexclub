import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLearningRecords,
  buildPairPlaybook,
  gradeObservation,
} from './signalLearningCore.js';

test('captures executed, watched, and rejected scan evidence with pair-specific confirmations', () => {
  const records = buildLearningRecords({
    userId: 'user_1',
    brokerAccountId: 'acct_1',
    environment: 'practice',
    engine: 'ict',
    scanMode: 'full',
    runId: 'run-1',
    observedAt: new Date('2026-07-27T12:30:00Z'),
    payload: {
      executed: [{
        pair: 'EUR_USD', direction: 'long', fillPrice: 1.1, stopLoss: 1.098,
        takeProfit: 1.104, expectedRR: 2, confidence: 94, currentPrice: 1.1,
        conceptsDetected: ['Liquidity Sweep', 'Displacement', 'FVG'],
      }],
      watchCandidates: [{
        pair: 'USD_JPY', direction: 'short', entry: 154.2, stopLoss: 154.5,
        takeProfit: 153.6, confidence: 88, currentPrice: 154.2,
        confirmations: { marketStructureShift: true },
      }],
      rejected: [{
        pair: 'GBP_USD', direction: 'long', entry: 1.28, stopLoss: 1.277,
        takeProfit: 1.286, reason: 'spread too high', currentPrice: 1.28,
      }],
    },
  });

  assert.equal(records.observations.length, 3);
  assert.equal(records.snapshots.length, 3);
  const eur = records.observations.find((row) => row.pair === 'EUR_USD');
  assert.equal(eur.status, 'executed');
  assert.equal(eur.confirmations.liquidity_sweep, true);
  assert.equal(eur.confirmations.displacement, true);
  assert.match(eur.confirmation_signature, /fvg/);
  const rejected = records.observations.find((row) => row.pair === 'GBP_USD');
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.rejection_reason, 'spread too high');
});

test('grades forward price snapshots in R and distinguishes target-first wins', () => {
  const observation = {
    id: 'obs-1',
    pair: 'EUR_USD',
    direction: 'long',
    observed_at: '2026-01-01T12:00:00.000Z',
    entry_price: 1.1,
    stop_loss: 1.098,
    take_profit: 1.104,
    projected_rr: 2,
  };
  const snapshots = [
    { observed_at: '2026-01-01T12:01:00.000Z', mid_price: 1.0995 },
    { observed_at: '2026-01-01T12:08:00.000Z', mid_price: 1.101 },
    { observed_at: '2026-01-01T12:14:00.000Z', mid_price: 1.1041 },
  ];
  const result = gradeObservation({ observation, snapshots, horizonMinutes: 15 });
  assert.equal(result.result, 'win');
  assert.equal(result.target_hit, true);
  assert.equal(result.stop_hit, false);
  assert.equal(result.realized_r, 2);
  assert.ok(result.max_r >= 2);
});

test('keeps small samples display-only and promotes evidence without activating live thresholds', () => {
  const small = buildPairPlaybook({
    pair: 'EUR_USD', engine: 'ict', summary: { outcomes: 7 },
  });
  assert.equal(small.stage, 'display_only');
  assert.equal(small.safeguards.liveThresholdsChanged, false);

  const mature = buildPairPlaybook({
    pair: 'EUR_USD',
    engine: 'ict',
    summary: { outcomes: 60, wins: 36, losses: 24, win_rate: 60, expectancy_r: 0.35, profit_factor: 1.5 },
    timeStats: [{
      session: 'london', time_bucket_15m: '03:15', direction: 'long', outcomes: 20,
      win_rate: 65, expectancy_r: 0.6, profit_factor: 1.8,
    }],
    confirmationStats: [{
      confirmation: 'liquidity_sweep', outcomes: 40, win_rate: 62,
      expectancy_r: 0.5, expectancy_lift_r: 0.2,
    }],
    comboStats: [{
      confirmation_signature: 'displacement+fvg+liquidity_sweep', outcomes: 35,
      win_rate: 66, expectancy_r: 0.7, profit_factor: 2,
    }],
    regimeStats: [{
      direction: 'long', market_regime: 'ranging', volatility: 'low',
      daily_direction: 'bearish', h4_direction: 'bearish', outcomes: 30,
      expectancy_r: -0.3,
    }],
  });

  assert.equal(mature.stage, 'calibration_ready');
  assert.equal(mature.status, 'shadow');
  assert.equal(mature.valuableConfirmations[0].confirmation, 'liquidity_sweep');
  assert.equal(mature.strongCombinations.length, 1);
  assert.equal(mature.safeguards.maxConfidenceAdjustment, 0);
});
