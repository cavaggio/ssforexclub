import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dailyStudyLearningCandidate,
  findUntestedZones,
  pprStudyAnalysisTime,
} from './dailyMarketStudy.js';

function candle(time, open, high, low, close) {
  return { time, open, high, low, close };
}

test('daily study retains highs and lows that later candles have not retested', () => {
  const zones = findUntestedZones([
    candle('2026-07-20', 1.5, 2, 1, 1.8),
    candle('2026-07-21', 1.8, 3, 1.5, 2.7),
    candle('2026-07-22', 2.7, 2.8, 2.2, 2.4),
  ], 'D');

  assert.ok(zones.some((zone) => zone.type === 'untested_low' && zone.price === 1));
  assert.ok(zones.some((zone) => zone.type === 'untested_high' && zone.price === 3));
  assert.ok(zones.some((zone) => zone.type === 'untested_low' && zone.price === 1.5));
  assert.ok(!zones.some((zone) => zone.type === 'untested_high' && zone.price === 2));
});

test('daily study ignores malformed candles rather than storing invalid zones', () => {
  const zones = findUntestedZones([
    { time: 'bad', open: 1, high: 0, low: 1, close: 1 },
    candle('2026-07-21', 1, 2, 0.5, 1.5),
    candle('2026-07-22', 1.5, 2.2, 1.2, 2),
  ], 'H4');

  assert.ok(zones.every((zone) => Number.isFinite(zone.price)));
  assert.ok(zones.every((zone) => zone.timeframe === 'H4'));
});

test('PPR daily study evaluates at the final eligible minute without changing the study date', () => {
  const actual = new Date('2026-07-28T02:02:00.000Z');
  const analysis = pprStudyAnalysisTime(actual);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(analysis);
  const read = (type) => parts.find((part) => part.type === type)?.value;
  assert.equal(`${read('year')}-${read('month')}-${read('day')}`, '2026-07-27');
  assert.equal(`${read('hour')}:${read('minute')}`, '09:59');
});

test('daily study rows become market-study observations with snapshots and context', () => {
  const candidate = dailyStudyLearningCandidate({
    engine: 'ict',
    pair: 'EUR_USD',
    study_date: '2026-07-27',
    studied_at: '2026-07-28T02:02:41.150Z',
    day_open: 1.13958,
    day_high: 1.14184,
    day_low: 1.1367,
    day_close: 1.13683,
    day_direction: 'bearish',
    prior_day_high: 1.14012,
    prior_day_low: 1.1365,
    institutional_flow: { type: 'buy_side_liquidity_raid', direction: 'bearish', strength: 'high' },
    untested_daily_zones: [{ timeframe: 'D', type: 'untested_low', price: 1.13618 }],
    untested_h4_zones: [{ timeframe: 'H4', type: 'untested_high', price: 1.13866 }],
    feature_snapshot: { sweptPriorHigh: true },
    engine_analysis: {
      ictBias: 'bearish',
      entry: 1.13743,
      stopLoss: 1.13795,
      target1: 1.13665,
      rr: 1.5,
      confidence: 73,
      conceptsDetected: ['BOS bearish', 'bearish FVG'],
      concepts: { missingConfluence: ['liquidity sweep', 'displacement'] },
      htf: { h4Bias: 'bearish' },
      session: { name: 'Asian' },
    },
  });

  assert.equal(candidate.status, 'market_study');
  assert.equal(candidate.pair, 'EUR_USD');
  assert.equal(candidate.direction, 'bearish');
  assert.equal(candidate.currentPrice, 1.13743);
  assert.equal(candidate.stopLoss, 1.13795);
  assert.equal(candidate.takeProfit, 1.13665);
  assert.equal(candidate.expectedRR, 1.5);
  assert.equal(candidate.dailyStudyContext.dayDirection, 'bearish');
  assert.equal(candidate.h4Direction, 'bearish');
  assert.deepEqual(candidate.missingConfirmations, ['liquidity sweep', 'displacement']);
});
