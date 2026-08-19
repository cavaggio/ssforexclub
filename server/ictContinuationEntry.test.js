import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyIctM5ContinuationEntry,
  resolveIctEntryAuthorization,
} from './ictContinuationEntry.js';

function m5Candles({ close = 1.1014, complete = true } = {}) {
  const start = Date.parse('2026-08-14T06:00:00Z');
  return Array.from({ length: 25 }, (_, index) => {
    const base = 1.1000 + (index * 0.00002);
    return {
      time: new Date(start + (index * 5 * 60_000)).toISOString(),
      open: index === 24 ? 1.1007 : base,
      high: index === 24 ? Math.max(close, 1.1007) + 0.0001 : base + 0.00012,
      low: index === 24 ? Math.min(close, 1.1007) - 0.0001 : base - 0.00008,
      close: index === 24 ? close : base + 0.00002,
      complete: index === 24 ? complete : true,
    };
  });
}

function bullishBreakout(overrides = {}) {
  const candles = m5Candles();
  return classifyIctM5ContinuationEntry({
    candles,
    bias: 'bullish',
    h1Bias: 'bullish',
    h1Momentum: { aligned: true, activeAligned: true, currentOpposing: false, activeDirection: 'bullish' },
    bos: {
      direction: 'bullish',
      brokenLevel: 1.1010,
      time: candles.at(-1).time,
    },
    displacement: {
      direction: 'bullish',
      candleIndex: candles.length - 1,
      createdFVG: false,
    },
    fvgs: [],
    orderBlock: null,
    atrPrice: 0.0005,
    now: new Date('2026-08-14T08:00:00Z'),
    ...overrides,
  });
}

test('aligned H1 plus a fresh completed M5 BOS authorizes continuation without mandatory FVG/OB', () => {
  const result = bullishBreakout();

  assert.equal(result.ready, true);
  assert.equal(result.mode, 'm5_continuation_breakout');
  assert.equal(result.bosAligned, true);
  assert.equal(result.pdArrayAligned, false);
  assert.match(result.cycleId, /^bullish:m5_continuation_breakout:/);
});

test('a just-closed breakout survives after the next live M5 candle opens', () => {
  const completed = m5Candles();
  const breakoutTime = completed.at(-1).time;
  const candles = [
    ...completed,
    {
      ...completed.at(-1),
      time: '2026-08-14T08:05:00.000Z',
      open: 1.1014,
      close: 1.10145,
      high: 1.1015,
      low: 1.10135,
      complete: false,
    },
  ];
  const result = classifyIctM5ContinuationEntry({
    candles,
    bias: 'bullish',
    h1Bias: 'bullish',
    h1Momentum: { aligned: true, activeAligned: true, currentOpposing: false },
    bos: { direction: 'bullish', brokenLevel: 1.1010, time: breakoutTime },
    atrPrice: 0.0005,
    now: new Date('2026-08-14T08:06:00Z'),
  });

  assert.equal(result.ready, true);
  assert.equal(result.triggerFresh, true);
  assert.ok(result.triggerAgeMinutes <= 10);
  assert.equal(result.breakoutTime, breakoutTime);
});

test('completed early-session direction can support continuation when current H1 is not opposing', () => {
  const result = bullishBreakout({
    h1Momentum: { aligned: false, activeAligned: false, currentOpposing: false },
    earlySessionDirection: { alignedWithBias: true, completedCount: 3, direction: 'bullish' },
  });

  assert.equal(result.ready, true);
  assert.equal(result.earlySessionAligned, true);
});

test('strong live H1 opposition still blocks continuation', () => {
  const result = bullishBreakout({
    h1Momentum: { aligned: true, activeAligned: true, currentOpposing: true, exhausted: true, reason: 'Live H1 reversed bearish.' },
    earlySessionDirection: { alignedWithBias: true, completedCount: 3, direction: 'bullish' },
  });

  assert.equal(result.ready, false);
  assert.equal(result.status, 'h1_momentum_exhausted');
});

test('an extended breakout is not chased and explicitly arms recovery', () => {
  const candles = m5Candles({ close: 1.1024 });
  const result = bullishBreakout({ candles, maxExtensionAtr: 2.0 });

  assert.equal(result.ready, false);
  assert.equal(result.status, 'await_recovery_pullback');
  assert.equal(result.recoveryArmed, true);
  assert.ok(result.extensionAtr > result.maxExtensionAtr);
  assert.match(result.reason, /Recovery is armed/i);
});

test('a first held retest can recover a missed breakout without requiring a PD array', () => {
  const candles = m5Candles({ close: 1.1011 });
  const result = classifyIctM5ContinuationEntry({
    candles,
    bias: 'bullish',
    h1Bias: 'bullish',
    h1Momentum: { aligned: true, activeAligned: true, currentOpposing: false },
    retest: { direction: 'bullish', retestLevel: 1.1010 },
    fvgs: [],
    orderBlock: null,
    atrPrice: 0.0005,
    now: new Date('2026-08-14T08:00:00Z'),
  });

  assert.equal(result.ready, true);
  assert.equal(result.mode, 'm5_continuation_recovery');
  assert.equal(result.pdArrayAligned, false);
});

test('a breakout older than 10 minutes is not chased but remains recovery-armed', () => {
  const candles = m5Candles();
  const result = bullishBreakout({
    candles,
    now: new Date('2026-08-14T08:11:00Z'),
  });

  assert.equal(result.ready, false);
  assert.equal(result.status, 'await_recovery_pullback');
  assert.equal(result.recoveryArmed, true);
  assert.ok(result.triggerAgeMinutes > 10);
});

test('entry authorization falls back to M5 continuation when no fresh H1 transition exists', () => {
  const authorization = resolveIctEntryAuthorization({
    h1Transition: { ready: false, transitionId: null, reason: 'H1 transition window ended.' },
    continuationBreakout: bullishBreakout(),
  });

  assert.equal(authorization.ready, true);
  assert.equal(authorization.mode, 'm5_continuation_breakout');
});
