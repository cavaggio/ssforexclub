import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeV3EntryTpHitConfidence,
  computeLiveV3TpHitConfidence,
  computePostFillRiskReward,
  priceForMinimumRR,
  repriceV3TpHitConfidence,
  isPureV3TradeRecord,
} from './v3TpConfidence.js';

test('explicit TP confidence wins over legacy entry confidence', () => {
  const value = computeV3EntryTpHitConfidence({
    strategy: 'V3',
    confidence: 2,
    tpHitConfidence: 88,
  });
  assert.equal(value, 88);
});

test('live V3 confidence is not floored by a 100 entry score', () => {
  const live = computeLiveV3TpHitConfidence({
    side: 'long',
    entryPrice: 1.1000,
    currentPrice: 1.0992,
    stopLoss: 1.0990,
    takeProfit: 1.1020,
    entryTpHitConfidence: 100,
    entryAlignmentScore: 90,
    currentAlignmentScore: 35,
    flowOpposes: true,
    mtfConflict: true,
    m15TrendReversed: true,
    trendWeakeningDetected: true,
    trendWeakeningSeverity: 'high',
  });
  assert.ok(live.tpHitConfidence < 45, JSON.stringify(live));
  assert.notEqual(live.exitRecommendation, 'HOLD');
});

test('invalidation caps live TP confidence and requests exit', () => {
  const live = computeLiveV3TpHitConfidence({
    side: 'short',
    entryPrice: 1.3000,
    currentPrice: 1.3010,
    stopLoss: 1.3020,
    takeProfit: 1.2970,
    entryTpHitConfidence: 96,
    invalidationDetected: true,
  });
  assert.ok(live.tpHitConfidence <= 5);
  assert.equal(live.exitRecommendation, 'EXIT_NOW');
});

test('post-fill TP repair restores at least 1.5R', () => {
  const fillPrice = 1.41605;
  const stopLoss = 1.41516;
  const oldTp = 1.41726;
  const before = computePostFillRiskReward({ direction: 'long', entry: fillPrice, stopLoss, takeProfit: oldTp });
  assert.ok(before < 1.5);
  const repaired = priceForMinimumRR({ direction: 'long', fillPrice, stopLoss, minRR: 1.5, priceDecimals: 5 });
  const after = computePostFillRiskReward({ direction: 'long', entry: fillPrice, stopLoss, takeProfit: repaired });
  assert.ok(after >= 1.5, `${repaired} => ${after}`);
});

test('post-fill TP confidence is repriced from actual broker geometry', () => {
  assert.equal(repriceV3TpHitConfidence({ baseConfidence: 85, originalRR: 1.5, actualRR: 1.75 }), 84);
  assert.equal(repriceV3TpHitConfidence({ baseConfidence: 85, originalRR: 2.0, actualRR: 1.5 }), 87);
});

test('recognizes a V3 trade-history record', () => {
  assert.equal(isPureV3TradeRecord({ entrySelectedLogicType: 'v3_pure' }), true);
  assert.equal(isPureV3TradeRecord({ entryStrategy: 'V3' }), true);
  assert.equal(isPureV3TradeRecord({ entrySelectedLogicType: 'forex' }), false);
});
