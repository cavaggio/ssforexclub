import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePairPlaybookExecutionGate } from './pairPlaybookExecutionGate.js';

const playbook = {
  id: 'pb-1',
  pair: 'EUR_USD',
  version: 39,
  is_current: true,
  status: 'active',
  recommendation_stage: 'calibration_ready',
  sample_size: 1724,
  validator: { approvedForAutoTradePriority: true },
  avoid_conditions: [{
    outcomes: 470,
    direction: 'short',
    expectancyR: -0.3763,
    h4Direction: 'bearish',
    dailyDirection: 'bearish',
  }],
};

test('mature negative-expectancy EURUSD bearish context blocks autonomous execution', () => {
  const result = evaluatePairPlaybookExecutionGate({
    pair: 'EUR_USD',
    signal: 'sell',
    timeframeBias: { d1: 'bearish', h4: 'bearish' },
  }, playbook);
  assert.equal(result.passed, false);
  assert.equal(result.decision, 'reject');
  assert.deepEqual(result.failureCodes, ['EDGE_NEGATIVE_EXPECTANCY_CONTEXT']);
  assert.equal(result.matchedCondition.outcomes, 470);
});

test('opposite direction does not inherit the bearish avoid condition', () => {
  const result = evaluatePairPlaybookExecutionGate({
    pair: 'EUR_USD',
    signal: 'buy',
    timeframeBias: { d1: 'bearish', h4: 'bearish' },
  }, playbook);
  assert.equal(result.passed, true);
});

test('display-only or immature playbooks cannot hard-block execution', () => {
  const result = evaluatePairPlaybookExecutionGate({
    pair: 'EUR_USD',
    signal: 'sell',
    timeframeBias: { d1: 'bearish', h4: 'bearish' },
  }, { ...playbook, status: 'display_only', sample_size: 1 });
  assert.equal(result.passed, true);
  assert.equal(result.authoritative, false);
});
