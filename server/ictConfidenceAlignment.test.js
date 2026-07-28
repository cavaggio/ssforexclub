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

test('current, fresh, natural-liquidity ICT scalp can clear the target-hit floor', () => {
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
  assert.equal(result.model, 'ict_current_entry_target_before_stop_v1');
});

test('missing trigger age is not silently converted to a fresh zero-age trigger', () => {
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

  assert.equal(result.eligible, false);
  assert.ok(result.blockers.some((reason) => reason.includes('not timestamped')));
});

test('raw confluence cannot hide a late, stale, already-consumed scalp entry', () => {
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

  assert.equal(result.eligible, false);
  assert.ok(result.confidence < 70);
  assert.ok(result.blockers.some((reason) => reason.includes('bars old')));
  assert.ok(result.blockers.some((reason) => reason.includes('already consumed')));
});

test('synthetically extending a target to manufacture 1.5R cannot qualify at 93%', () => {
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

  assert.equal(result.eligible, false);
  assert.ok(result.confidence < 93);
  assert.ok(result.blockers.some((reason) => reason.includes('natural liquidity target')));
});

test('fresh bid/ask repricing can reject a scanner-qualified setup before fill', () => {
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
  assert.ok(result.blockers.some((reason) => reason.includes('drifted') || reason.includes('consumed')));
});

test('ICT TP and SL probabilities are decimal ratios expected by the dashboard', () => {
  assert.deepEqual(ictProbabilitiesFromConfidence(95), {
    tpProbability: 0.95,
    slProbability: 0.05,
  });
});

test('generated runtime source uses one ICT target-hit model across scan, fill, open trade, and reassess', () => {
  const engine = fs.readFileSync(path.join(ROOT, 'server', 'ictEngine.js'), 'utf8');
  const execution = fs.readFileSync(path.join(ROOT, 'server', 'ictExecution.js'), 'utf8');
  const monitor = fs.readFileSync(path.join(ROOT, 'server', 'oandaActiveTradeMonitor.js'), 'utf8');
  const reassessor = fs.readFileSync(path.join(ROOT, 'server', 'oandaActiveTradeReassessor.js'), 'utf8');

  assert.match(engine, /computeIctTargetHitConfidence/);
  assert.match(engine, /Hard gate: late market entry/);
  assert.match(execution, /Final executable-price target-hit confirmation rejected/);
  assert.match(monitor, /ict_target_hit_lifecycle/);
  assert.match(reassessor, /source = 'ict_target_hit_lifecycle'/);
});
