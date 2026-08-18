import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateIctCorrectiveGate, ICT_FAILURE_CODES } from './ictCorrectiveGate.js';

const timeframeBias = {
  d1: 'bullish', h4: 'bullish', h1: 'bullish', d1H4Aligned: true, direction: 'buy',
};

test('continuation requires D1/H4, active H1 momentum, and a fresh M5 trigger', () => {
  const passed = evaluateIctCorrectiveGate({
    direction: 'bullish',
    timeframeBias,
    h1Momentum: { aligned: true, activeAligned: true },
    entryAuthorization: { ready: true, mode: 'm5_continuation_breakout', cycleId: 'cycle:1' },
    triggerAgeBars: 1,
    freshImpulse: true,
  });
  assert.equal(passed.passed, true);

  const exhausted = evaluateIctCorrectiveGate({
    direction: 'bullish',
    timeframeBias,
    h1Momentum: { aligned: false, exhausted: true, reason: 'Momentum ended.' },
    entryAuthorization: { ready: true, mode: 'm5_continuation_breakout', cycleId: 'cycle:2' },
    triggerAgeBars: 0,
    freshImpulse: true,
  });
  assert.equal(exhausted.passed, false);
  assert.ok(exhausted.failureCodes.includes(ICT_FAILURE_CODES.H1_MOMENTUM_EXHAUSTED));
});

test('reversal requires the full HTF tap, sweep, displacement, CISD/MSS, fresh-M5 sequence', () => {
  const base = {
    direction: 'bullish',
    timeframeBias,
    entryAuthorization: { ready: true, mode: 'initial_reversal_mss', cycleId: 'cycle:reversal' },
    triggerAgeBars: 0,
    freshImpulse: true,
    marketMakerModel: {
      keyLevelTap: { aligned: true },
      cycle: {
        keyLevel: { tappedAt: '2026-08-17T12:00:00Z' },
        manipulation: { time: '2026-08-17T12:05:00Z' },
        displacement: { time: '2026-08-17T12:10:00Z' },
      },
      observation: { mssAligned: true },
    },
  };
  assert.equal(evaluateIctCorrectiveGate(base).passed, true);

  const incomplete = evaluateIctCorrectiveGate({
    ...base,
    marketMakerModel: { keyLevelTap: { aligned: true }, cycle: {}, observation: {} },
  });
  assert.equal(incomplete.passed, false);
  assert.ok(incomplete.failureCodes.includes(ICT_FAILURE_CODES.LIQUIDITY_SWEEP_MISSING));
  assert.ok(incomplete.failureCodes.includes(ICT_FAILURE_CODES.OPPOSING_DISPLACEMENT_MISSING));
  assert.ok(incomplete.failureCodes.includes(ICT_FAILURE_CODES.CISD_MSS_MISSING));
});

test('confidence is absent from the corrective gate and cannot override a stale trigger', () => {
  const result = evaluateIctCorrectiveGate({
    direction: 'bullish',
    timeframeBias,
    h1Momentum: { aligned: true },
    entryAuthorization: { ready: true, mode: 'm5_continuation_cisd', cycleId: 'cycle:3' },
    triggerAgeBars: 2,
    freshImpulse: true,
    confidence: 100,
  });
  assert.equal(result.passed, false);
  assert.ok(result.failureCodes.includes(ICT_FAILURE_CODES.STALE_M5_TRIGGER));
});
