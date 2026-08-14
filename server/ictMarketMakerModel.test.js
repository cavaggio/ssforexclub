import test from 'node:test';
import assert from 'node:assert/strict';

import { detectCISD, detectInverseFVG } from './ictConcepts.js';
import {
  advanceIctMarketMakerCycle,
  createIctMarketMakerCycle,
  detectHtfKeyLevelTap,
  ICT_MARKET_MAKER_STAGES,
} from './ictMarketMakerModel.js';

const candle = (open, high, low, close, minute, complete = true) => ({
  open, high, low, close, complete,
  time: new Date(Date.UTC(2026, 5, 4, 6, minute)).toISOString(),
});

test('bullish iFVG requires a completed close through a prior bearish imbalance', () => {
  const candles = [
    candle(1.1050, 1.1060, 1.1040, 1.1050, 0),
    candle(1.1050, 1.1055, 1.1000, 1.1010, 5),
    candle(1.1010, 1.1030, 1.1005, 1.1020, 10),
    candle(1.1020, 1.1037, 1.1015, 1.1035, 15),
    candle(1.1035, 1.1050, 1.1030, 1.1045, 20),
    candle(1.1045, 1.1055, 1.1040, 1.1050, 25),
  ];
  const result = detectInverseFVG({ candles, pair: 'EUR_USD', direction: 'bullish' });
  assert.equal(result.confirmed, true);
  assert.equal(result.sourceType, 'bearish');
  assert.equal(result.brokenLevel, 1.104);
});

test('CISD confirms when the latest candle closes through the opposing delivery sequence', () => {
  const candles = [
    candle(1.1030, 1.1052, 1.1028, 1.1050, 0),
    candle(1.1040, 1.1052, 1.1038, 1.1050, 5),
    candle(1.1040, 1.1042, 1.1018, 1.1020, 10),
    candle(1.1020, 1.1022, 1.0998, 1.1000, 15),
    candle(1.1000, 1.1055, 1.0999, 1.1050, 20),
  ];
  const result = detectCISD({ candles, pair: 'EUR_USD', direction: 'bullish' });
  assert.equal(result.confirmed, true);
  assert.equal(result.direction, 'bullish');
  assert.equal(result.brokenLevel, 1.104);
});

test('HTF key-level detector recognizes a recent tap of the previous Daily low', () => {
  const dailyCandles = [
    candle(1.1100, 1.1200, 1.1000, 1.1150, 0),
  ];
  const m5Candles = Array.from({ length: 20 }, (_, index) =>
    candle(1.1015, 1.1020, index === 18 ? 1.0999 : 1.1010, 1.1016, index)
  );
  const result = detectHtfKeyLevelTap({
    dailyCandles,
    h4Candles: [],
    m5Candles,
    direction: 'bullish',
    pair: 'EUR_USD',
    atrPrice: 0.001,
  });
  assert.equal(result.aligned, true);
  assert.equal(result.source, 'previous_day_low');
  assert.equal(result.timeframe, 'D1');
});

function context(cycle = null) {
  return {
    studyReady: true,
    studyDate: '2026-06-04',
    studiedAt: '2026-06-04T06:00:00.000Z',
    cycle,
  };
}

function observation(overrides = {}) {
  return {
    pair: 'EUR_USD',
    direction: 'bullish',
    htfAligned: true,
    h1Aligned: true,
    keyLevelTap: { aligned: false },
    sweepAligned: false,
    sweep: null,
    displacementFresh: false,
    displacement: null,
    fvgAligned: false,
    mssAligned: false,
    inverseFvg: { confirmed: false },
    cisd: { confirmed: false },
    continuationBreakout: { ready: false },
    ...overrides,
  };
}

test('persistent Power-of-Three state advances only in the required order', () => {
  let cycle = createIctMarketMakerCycle({
    pair: 'EUR_USD', direction: 'bullish', studyDate: '2026-06-04', studiedAt: '2026-06-04T06:00:00.000Z',
  });

  let result = advanceIctMarketMakerCycle({
    context: context(cycle),
    observation: observation({ keyLevelTap: { aligned: true, source: 'h4_bullish_fvg', tappedAt: '2026-06-04T06:10:00.000Z' } }),
    now: '2026-06-04T06:10:00.000Z',
  });
  assert.equal(result.cycle.stage, ICT_MARKET_MAKER_STAGES.KEY_TAPPED);
  assert.equal(result.entryAuthorization.ready, false);
  cycle = result.cycle;

  result = advanceIctMarketMakerCycle({
    context: context(cycle),
    observation: observation({ sweepAligned: true, sweep: { sweptPriceLevel: 1.1, time: '2026-06-04T06:15:00.000Z' } }),
    now: '2026-06-04T06:15:00.000Z',
  });
  assert.equal(result.cycle.stage, ICT_MARKET_MAKER_STAGES.MANIPULATION);
  cycle = result.cycle;

  result = advanceIctMarketMakerCycle({
    context: context(cycle),
    observation: observation({ displacementFresh: true, displacement: { direction: 'bullish', createdFVG: true, displacementScore: 90 } }),
    now: '2026-06-04T06:20:00.000Z',
  });
  assert.equal(result.cycle.stage, ICT_MARKET_MAKER_STAGES.DISPLACEMENT);
  cycle = result.cycle;

  result = advanceIctMarketMakerCycle({
    context: context(cycle),
    observation: observation({ fvgAligned: true, mssAligned: true, mss: { confirmed: true, direction: 'bullish', time: '2026-06-04T06:25:00.000Z' } }),
    now: '2026-06-04T06:25:00.000Z',
  });
  assert.equal(result.cycle.stage, ICT_MARKET_MAKER_STAGES.ACTIVE);
  assert.equal(result.entryAuthorization.ready, true);
  assert.equal(result.entryAuthorization.mode, 'initial_reversal_mss');
});

test('a sweep timestamped before the HTF tap cannot advance manipulation', () => {
  const cycle = {
    ...createIctMarketMakerCycle({
      pair: 'EUR_USD', direction: 'bullish', studyDate: '2026-06-04', studiedAt: '2026-06-04T06:00:00.000Z',
    }),
    stage: ICT_MARKET_MAKER_STAGES.KEY_TAPPED,
    keyLevel: { aligned: true, source: 'previous_day_low', tappedAt: '2026-06-04T06:20:00.000Z' },
  };
  const result = advanceIctMarketMakerCycle({
    context: context(cycle),
    observation: observation({
      sweepAligned: true,
      sweep: { sweptPriceLevel: 1.1, time: '2026-06-04T06:15:00.000Z' },
      displacementFresh: true,
      displacement: { direction: 'bullish', createdFVG: true, time: '2026-06-04T06:25:00.000Z' },
      fvgAligned: true,
      mssAligned: true,
      mss: { confirmed: true, direction: 'bullish', time: '2026-06-04T06:30:00.000Z' },
    }),
    now: '2026-06-04T06:30:00.000Z',
  });
  assert.equal(result.cycle.stage, ICT_MARKET_MAKER_STAGES.KEY_TAPPED);
  assert.equal(result.entryAuthorization.ready, false);
});

test('continuation entries require an active parent cycle and aligned H1', () => {
  const activeCycle = {
    ...createIctMarketMakerCycle({
      pair: 'EUR_USD', direction: 'bullish', studyDate: '2026-06-04', studiedAt: '2026-06-04T06:00:00.000Z',
    }),
    stage: ICT_MARKET_MAKER_STAGES.ACTIVE,
    activationId: '2026-06-04:EUR_USD:bullish:h4_fvg:0610',
    activatedAt: '2026-06-04T06:25:00.000Z',
  };
  const ready = advanceIctMarketMakerCycle({
    context: context(activeCycle),
    observation: observation({
      continuationBreakout: { ready: true, mode: 'm5_continuation_retest', cycleId: 'retest:1.101' },
    }),
    now: '2026-06-04T06:40:00.000Z',
  });
  assert.equal(ready.entryAuthorization.ready, true);
  assert.equal(ready.entryAuthorization.mode, 'm5_continuation_retest');
  assert.match(ready.entryAuthorization.cycleId, /2026-06-04:EUR_USD:bullish/);

  const blocked = advanceIctMarketMakerCycle({
    context: context(activeCycle),
    observation: observation({
      h1Aligned: false,
      continuationBreakout: { ready: true, mode: 'm5_continuation_breakout', cycleId: 'break:1.102' },
    }),
    now: '2026-06-04T06:45:00.000Z',
  });
  assert.equal(blocked.entryAuthorization.ready, false);
  assert.match(blocked.entryAuthorization.reason, /H1 no longer aligns/i);
});

test('execution remains fail-closed when the 02:00 ET study is missing', () => {
  const result = advanceIctMarketMakerCycle({
    context: { studyReady: false },
    observation: observation({
      keyLevelTap: { aligned: true },
      sweepAligned: true,
      displacementFresh: true,
      fvgAligned: true,
      mssAligned: true,
    }),
    now: '2026-06-04T06:30:00.000Z',
  });
  assert.equal(result.entryAuthorization.ready, false);
  assert.match(result.entryAuthorization.reason, /02:00 ET ICT market study/i);
});
