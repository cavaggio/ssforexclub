import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeIctTargetHitConfidence,
  repriceIctTargetHitConfidence,
  ictProbabilitiesFromConfidence,
} from './ictTargetConfidence.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('current executable ICT scalp can clear the target-hit floor', () => {
  const result = computeIctTargetHitConfidence({
    confluenceScore: 95,
    freshImpulse: true,
    triggerAgeBars: 0,
    entryDriftAtr: 0.05,
    rewardConsumedFraction: 0.02,
    priceInsideEntryZone: true,
    actualRR: 2,
    minimumRR: 1.5,
    targetAdjusted: false,
    spreadPips: 1,
    maxSpreadPips: 3.5,
    minConfidence: 93,
  });

  assert.equal(result.eligible, true);
  assert.ok(result.confidence >= 93);
  assert.equal(result.signalQualityConfidence, 95);
  assert.ok(result.executionQualityConfidence >= 90);
  assert.equal(result.model, 'ict_signal_execution_quality_v3');
});

test('displayed 1.50R is not rejected because of floating-point residue', () => {
  const result = computeIctTargetHitConfidence({
    confluenceScore: 100,
    freshImpulse: true,
    triggerAgeBars: 0,
    entryDriftAtr: 0,
    rewardConsumedFraction: 0,
    priceInsideEntryZone: true,
    actualRR: 1.4999999998,
    minimumRR: 1.5,
    spreadPips: 0,
    minConfidence: 93,
  });

  assert.equal(result.actualRR, 1.5);
  assert.equal(result.minimumRR, 1.5);
  assert.equal(result.eligible, true);
  assert.ok(!result.blockers.some((reason) => reason.includes('R:R')));
});

test('a true displayed 1.49R remains below the 1.50 floor', () => {
  const result = computeIctTargetHitConfidence({
    confluenceScore: 100,
    freshImpulse: true,
    triggerAgeBars: 0,
    entryDriftAtr: 0,
    rewardConsumedFraction: 0,
    priceInsideEntryZone: true,
    actualRR: 1.494,
    minimumRR: 1.5,
    spreadPips: 0,
    minConfidence: 93,
  });

  assert.equal(result.actualRR, 1.49);
  assert.equal(result.eligible, false);
  assert.ok(result.blockers.some((reason) => reason.includes('R:R')));
});

test('missing trigger age remains a diagnostic and applies only a bounded penalty', () => {
  const result = computeIctTargetHitConfidence({
    confluenceScore: 100,
    freshImpulse: true,
    triggerAgeBars: null,
    entryDriftAtr: 0,
    rewardConsumedFraction: 0,
    priceInsideEntryZone: true,
    actualRR: 2,
    minConfidence: 93,
  });

  assert.equal(result.eligible, true);
  assert.equal(result.triggerAgeBars, null);
  assert.ok(result.timingScore < 100);
  assert.ok(result.executionQualityAdjustment <= 0);
  assert.ok(result.executionQualityAdjustment >= -3);
  assert.ok(!result.blockers.some((reason) => reason.includes('not timestamped')));
});

test('late and consumed metrics reduce execution quality without becoming a new hard gate', () => {
  const result = computeIctTargetHitConfidence({
    confluenceScore: 100,
    freshImpulse: true,
    triggerAgeBars: 3,
    entryDriftAtr: 0.7,
    rewardConsumedFraction: 0.45,
    priceInsideEntryZone: false,
    actualRR: 1.8,
    targetAdjusted: false,
    minConfidence: 93,
  });

  assert.equal(result.eligible, true);
  assert.ok(result.timingScore < 70);
  assert.equal(result.entryDriftAtr, 0.7);
  assert.equal(result.rewardConsumedFraction, 0.45);
  assert.equal(result.priceInsideEntryZone, false);
  assert.equal(result.signalQualityConfidence, 100);
  assert.ok(result.executionQualityConfidence < result.signalQualityConfidence);
  assert.ok(result.executionQualityAdjustment < 0);
  assert.ok(result.executionQualityAdjustment >= -3);
  assert.ok(!result.blockers.some((reason) => /bars old|consumed|drifted|entry zone/i.test(reason)));
});

test('an exact 1.5R current scalp may execute even when the target was normalized to the floor', () => {
  const result = computeIctTargetHitConfidence({
    confluenceScore: 100,
    freshImpulse: true,
    triggerAgeBars: 0,
    entryDriftAtr: 0,
    rewardConsumedFraction: 0,
    priceInsideEntryZone: true,
    actualRR: 1.5,
    targetAdjusted: true,
    minConfidence: 93,
  });

  assert.equal(result.eligible, true);
  assert.ok(result.confidence >= 93);
  assert.equal(result.targetAdjusted, true);
  assert.ok(!result.blockers.some((reason) => reason.includes('natural liquidity target')));
});

test('fresh bid/ask repricing still rejects when executable R:R falls below 1.5', () => {
  const analysis = {
    entry: 163.90,
    idealEntry: 163.90,
    entryZoneLow: 163.88,
    entryZoneHigh: 163.91,
    entrySource: 'FVG',
    stopLoss: 163.70,
    target1: 164.20,
    atrPips: 20,
    confluenceScore: 98,
    freshImpulse: true,
    triggerAgeBars: 0,
    minimumRR: 1.5,
    targetAdjustedToMinRR: false,
  };

  const result = repriceIctTargetHitConfidence({
    analysis,
    pair: 'USD_JPY',
    direction: 'long',
    executablePrice: 164.05,
    spreadPips: 1.5,
    maxSpreadPips: 3.5,
    minConfidence: 93,
  });

  assert.equal(result.eligible, false);
  assert.ok(result.blockers.some((reason) => reason.includes('R:R')));
});

test('ICT TP and SL probabilities are decimal ratios expected by the dashboard', () => {
  assert.deepEqual(ictProbabilitiesFromConfidence(95), {
    tpProbability: 0.95,
    slProbability: 0.05,
  });
});

test('generated runtime source uses separated signal and execution quality across scan and fill', () => {
  const engine = fs.readFileSync(path.join(ROOT, 'server', 'ictEngine.js'), 'utf8');
  const targetConfidence = fs.readFileSync(path.join(ROOT, 'server', 'ictTargetConfidence.js'), 'utf8');
  const execution = fs.readFileSync(path.join(ROOT, 'server', 'ictExecution.js'), 'utf8');
  const monitor = fs.readFileSync(path.join(ROOT, 'server', 'oandaActiveTradeMonitor.js'), 'utf8');
  const reassessor = fs.readFileSync(path.join(ROOT, 'server', 'oandaActiveTradeReassessor.js'), 'utf8');

  assert.match(engine, /computeIctTargetHitConfidence/);
  assert.match(engine, /executableRRRaw/);
  assert.match(engine, /minimumExecutableRR/);
  assert.doesNotMatch(engine, /Hard gate: late market entry/);
  assert.match(targetConfidence, /ict_signal_execution_quality_v3/);
  assert.match(targetConfidence, /const rrRaw =/);
  assert.match(targetConfidence, /const rrFloorRaw =/);
  assert.match(targetConfidence, /signalQualityConfidence/);
  assert.match(targetConfidence, /executionQualityConfidence/);
  assert.match(execution, /selectIctPairQuote\(pricingPayload, pair\)/);
  assert.match(execution, /Final executable-price confirmation rejected for \$\{pair\}/);
  assert.match(execution, /accurateBlockers/);
  assert.match(execution, /authoritativeAnalysis/);
  assert.match(monitor, /ict_target_hit_lifecycle/);
  assert.match(reassessor, /source = 'ict_target_hit_lifecycle'/);
});
