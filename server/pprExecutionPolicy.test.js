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
    pair: 'EUR_USD',
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
    },
    pprConfirmation: {
      allowed: true,
      dailyBias: 'bullish',
      targetType: 'swing_high_liquidity',
      session: 'London_to_New_York',
      volumeSpike: true,
      manipulationType: 'liquidity_raid',
      manipulationSubtype: 'sell_side_stop_hunt',
      candleConfirmation: 'bullish',
      confirmedAt: '2026-07-14T08:00:00.000Z',
    },
    ppr: {
      manipulation: { type: 'liquidity_raid', level: 1.1 },
      liquidityTarget: { price: 1.115 },
    },
  };
}

test('PPR policy accepts a complete PPR-native signal', () => {
  const signal = validSignal();
  assert.equal(isPprExecutionSignal(signal), true);
  assert.deepEqual(evaluatePprExecutionPolicy(signal), {
    allowed: true,
    reasons: [],
    engine: 'ppr',
    expectedBias: 'bullish',
    manipulationType: 'liquidity_raid',
    session: 'London_to_New_York',
    rr: 2,
  });
});

test('PPR policy blocks direction/bias conflicts and missing manipulation', () => {
  const signal = validSignal();
  signal.direction = 'short';
  signal.pprConfirmation.manipulationType = 'none';
  const result = evaluatePprExecutionPolicy(signal);
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((reason) => reason.includes('does not match')));
  assert.ok(result.reasons.some((reason) => reason.includes('manipulation')));
});

test('PPR fingerprint is strategy-specific and changes with trigger confirmation', () => {
  const first = validSignal();
  const second = validSignal();
  second.pprConfirmation.confirmedAt = '2026-07-14T08:05:00.000Z';
  assert.match(pprSetupFingerprint(first, 'ACCOUNT'), /ACCOUNT\|ppr\|EUR_USD/);
  assert.notEqual(pprSetupFingerprint(first, 'ACCOUNT'), pprSetupFingerprint(second, 'ACCOUNT'));
});

test('PPR strategy modules do not import legacy, V3, or ICT strategy code', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const strategyFiles = ['pprEngine.js', 'pprExecutionPolicy.js'];
  for (const file of strategyFiles) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(source, /from ['"].*(oandaScanner|v3Engine|v3IndependentScanner|ictEngine|ictConcepts|ictExecution)/i, file);
  }
});
