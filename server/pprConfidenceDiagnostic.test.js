import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluatePprExecutionPolicy } from './pprExecutionPolicy.js';

const serverRoot = path.dirname(fileURLToPath(import.meta.url));

function validPprSignal() {
  return {
    pair: 'GBP_USD',
    direction: 'long',
    engine: 'ppr',
    strategy: 'PPR',
    source: 'ppr_auto_ai',
    selectedLogicType: 'ppr_native',
    score: 0,
    confidence: 1,
    entryQualityConfidence: 1,
    stopLoss: 1.095,
    takeProfit: 1.115,
    expectedRR: 2,
    lifecycle: {
      source: 'ppr_native_geometry',
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
      volumeSpike: true,
      manipulationType: 'liquidity_raid',
      manipulationTypes: ['liquidity_raid'],
      manipulationDistancePips: 5,
      session: 'London',
      confirmedAt: '2026-07-20T06:05:00.000Z',
    },
    ppr: {
      manipulation: {
        type: 'liquidity_raid',
        types: ['liquidity_raid'],
        entryReferencePrice: 1.1,
        distancePips: 5,
      },
      liquidityTarget: { price: 1.115 },
    },
  };
}

test('PPR native execution policy ignores diagnostic confidence and derived score', () => {
  const result = evaluatePprExecutionPolicy(validPprSignal());
  assert.equal(result.allowed, true);
  assert.deepEqual(result.reasons, []);
});

test('generated PPR scanner preserves confidence only as diagnostic metadata', () => {
  const source = fs.readFileSync(path.join(serverRoot, 'pprEngine.js'), 'utf8');

  assert.doesNotMatch(source, /if \(confidence < config\.minConfidence\)/);
  assert.match(source, /confidencePolicy: 'diagnostic_only'/);
  assert.match(source, /affectsQualification: false/);
  assert.match(source, /affectsExecution: false/);
  assert.match(source, /affectsPositionSizing: false/);
});

test('generated OANDA executor bypasses PPR confidence and score gates', () => {
  const source = fs.readFileSync(path.join(serverRoot, 'oandaTrade.js'), 'utf8');

  assert.match(source, /if \(!purePprExecution && score < MIN_SCORE\)/);
  assert.match(
    source,
    /if \(!purePprExecution && \(!Number\.isFinite\(confidence\) \|\| confidence < executionConfidenceFloor\)\)/,
  );
  assert.match(source, /if \(autoAi && !purePprExecution\)/);
  assert.match(source, /riskSizingConfidence = purePprExecution \? MIN_CONFIDENCE : signal\.confidence/);
  assert.match(source, /riskSizingScore = purePprExecution \? null : signal\.score/);
  assert.match(source, /ppr_fixed_min_risk_confidence_diagnostic_only/);
  assert.match(source, /confidenceAffectedExecution: false/);
  assert.match(source, /confidenceAffectedSizing: false/);
});
