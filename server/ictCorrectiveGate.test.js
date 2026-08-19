import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateIctCorrectiveGate, ICT_FAILURE_CODES } from './ictCorrectiveGate.js';

const timeframeBias = {
  d1: 'bullish', h4: 'bullish', h1: 'bullish', d1H4Aligned: true, direction: 'buy',
};

test('continuation accepts active H1 momentum and a fresh M5 trigger', () => {
  const passed = evaluateIctCorrectiveGate({
    direction: 'bullish',
    timeframeBias,
    h1Momentum: { aligned: true, activeAligned: true },
    entryAuthorization: { ready: true, mode: 'm5_continuation_breakout', cycleId: 'cycle:1' },
    triggerAgeBars: 1,
    freshImpulse: true,
  });
  assert.equal(passed.passed, true);
});

test('completed 01:00-03:00 ET direction can confirm continuation when H1 is not actively opposing', () => {
  const result = evaluateIctCorrectiveGate({
    direction: 'bullish',
    timeframeBias,
    h1Momentum: { aligned: false, activeAligned: false, currentOpposing: false },
    earlySessionDirection: { alignedWithBias: true, completedCount: 3, direction: 'bullish' },
    entryAuthorization: { ready: true, mode: 'm5_continuation_recovery', cycleId: 'cycle:session' },
    triggerAgeBars: 2,
    freshImpulse: true,
  });
  assert.equal(result.passed, true);
});

test('strong live H1 opposition still vetoes a continuation', () => {
  const exhausted = evaluateIctCorrectiveGate({
    direction: 'bullish',
    timeframeBias,
    h1Momentum: { aligned: true, currentOpposing: true, exhausted: true, reason: 'Live H1 is bearish.' },
    earlySessionDirection: { alignedWithBias: true, completedCount: 3, direction: 'bullish' },
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

test('two M5 bars remain fresh but a third bar is stale', () => {
  const fresh = evaluateIctCorrectiveGate({
    direction: 'bullish',
    timeframeBias,
    h1Momentum: { aligned: true },
    entryAuthorization: { ready: true, mode: 'm5_continuation_breakout', cycleId: 'cycle:fresh' },
    triggerAgeBars: 2,
    freshImpulse: true,
  });
  assert.equal(fresh.passed, true);

  const stale = evaluateIctCorrectiveGate({
    direction: 'bullish',
    timeframeBias,
    h1Momentum: { aligned: true },
    entryAuthorization: { ready: true, mode: 'm5_continuation_breakout', cycleId: 'cycle:stale' },
    triggerAgeBars: 3,
    freshImpulse: true,
    confidence: 100,
  });
  assert.equal(stale.passed, false);
  assert.ok(stale.failureCodes.includes(ICT_FAILURE_CODES.STALE_M5_TRIGGER));
});
