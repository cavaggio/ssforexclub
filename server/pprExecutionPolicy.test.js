import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluatePprExecutionPolicy,
  isPprExecutionSignal,
  pprSetupFingerprint,
} from './pprExecutionPolicy.js';

function validSignal() {
  return {
    pair: 'GBP_USD',
    direction: 'long',
    engine: 'ppr',
    strategy: 'PPR',
    source: 'ppr_auto_ai',
    selectedLogicType: 'ppr_native',
    stopLoss: 1.095,
    takeProfit: 1.115,
    expectedRR: 2,
    generatedAt: '2026-07-14T08:00:00.000Z',
    lifecycle: {
      source: 'ppr_native_geometry',
      sl: { stopLossPips: 50, stopLossPrice: 1.095 },
      tp: { takeProfitPips: 100, takeProfitPrice: 1.115 },
      management: {
        automatedManagement: false,
        cutoffEt: '10:00',
        afterCutoff: 'manual_only',
      },
    },
    pprConfirmation: {
      allowed: true,
      dailyBias: 'bullish',
      dailyEma: 9,
      h1Ema: 9,
      h1EmaAligned: true,
      targetType: 'liquidity_cluster',
      targetSources: ['h1_swing_high', 'previous_day_high'],
      session: 'London_to_New_York',
      volumeSpike: true,
      manipulationType: 'composite_misdirection',
      manipulationTypes: ['liquidity_raid', 'fvg_mitigation'],
      manipulationSubtypes: ['sell_side_stop_hunt', 'bullish_fvg'],
      manipulationDistancePips: 6,
      candleConfirmation: 'bullish',
      managementCutoffEt: '10:00',
      managementAfterCutoff: 'manual_only',
      confirmedAt: '2026-07-14T08:00:00.000Z',
    },
    ppr: {
      manipulation: {
        type: 'composite_misdirection',
        types: ['liquidity_raid', 'fvg_mitigation'],
        entryReferencePrice: 1.1,
        distancePips: 6,
      },
      liquidityTarget: { price: 1.115 },
    },
  };
}

test('PPR policy accepts composite native misdirection with EMA9 and manual-after-10 management', () => {
  const signal = validSignal();
  assert.equal(isPprExecutionSignal(signal), true);
  const result = evaluatePprExecutionPolicy(signal);
  assert.equal(result.allowed, true);
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.manipulationTypes, ['liquidity_raid', 'fvg_mitigation']);
  assert.equal(result.distancePips, 6);
  assert.equal(result.managementCutoffEt, '10:00');
  assert.equal(result.afterCutoff, 'manual_only');
});

test('PPR policy blocks Daily/H1 EMA9 conflicts and entries beyond 12 pips', () => {
  const signal = validSignal();
  signal.pprConfirmation.dailyEma = 20;
  signal.pprConfirmation.h1EmaAligned = false;
  signal.pprConfirmation.manipulationDistancePips = 12.1;
  const result = evaluatePprExecutionPolicy(signal);
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((reason) => reason.includes('Daily EMA')));
  assert.ok(result.reasons.some((reason) => reason.includes('H1 EMA9')));
  assert.ok(result.reasons.some((reason) => reason.includes('12 pips')));
});

test('PPR policy blocks automated management and requires manual-only after 10:00 ET', () => {
  const signal = validSignal();
  signal.lifecycle.management.automatedManagement = true;
  signal.lifecycle.management.afterCutoff = 'auto_close';
  const result = evaluatePprExecutionPolicy(signal);
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((reason) => reason.includes('automated trade management')));
  assert.ok(result.reasons.some((reason) => reason.includes('manual-only')));
});

test('PPR fingerprint is strategy-specific and changes with combined trigger confirmation', () => {
  const first = validSignal();
  const second = validSignal();
  second.pprConfirmation.manipulationTypes = ['order_block_retest'];
  assert.match(pprSetupFingerprint(first, 'ACCOUNT'), /ACCOUNT\|ppr\|GBP_USD/);
  assert.notEqual(pprSetupFingerprint(first, 'ACCOUNT'), pprSetupFingerprint(second, 'ACCOUNT'));
});

test('PPR strategy modules do not import legacy, V3, or ICT strategy code', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const strategyFiles = ['pprEngine.js', 'pprExecutionPolicy.js'];
  for (const file of strategyFiles) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(
      source,
      /from ['"].*(oandaScanner|v3Engine|v3IndependentScanner|ictEngine|ictConcepts|ictExecution)/i,
      file,
    );
  }
});
