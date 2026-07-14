import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decideAutoAiClose,
  inAutoAiEntryWindow,
  inAutoAiManagementWindow,
} from './autoAiActiveTradePolicy.js';

test('Auto AI may enter through 1:59 PM ET but not at 2:00 PM ET', () => {
  assert.equal(inAutoAiEntryWindow(new Date('2026-07-14T17:59:00Z')), true);
  assert.equal(inAutoAiEntryWindow(new Date('2026-07-14T18:00:00Z')), false);
});

test('active-trade management remains available through the 5 PM ET sweep', () => {
  assert.equal(inAutoAiManagementWindow(new Date('2026-07-14T20:59:00Z')), true);
  assert.equal(inAutoAiManagementWindow(new Date('2026-07-14T21:00:00Z')), true);
  assert.equal(inAutoAiManagementWindow(new Date('2026-07-14T21:05:00Z')), false);
});

test('weekends do not open entry or management windows', () => {
  const saturday = new Date('2026-07-18T16:00:00Z');
  assert.equal(inAutoAiEntryWindow(saturday), false);
  assert.equal(inAutoAiManagementWindow(saturday), false);
});

test('medium reversal risk closes the trade', () => {
  const decision = decideAutoAiClose({
    invalidationDetected: true,
    invalidationSeverity: 'medium',
  }, new Date('2026-07-14T15:00:00Z'));

  assert.equal(decision.close, true);
  assert.equal(decision.category, 'reversal_risk');
  assert.equal(decision.severity, 'medium');
});

test('low reversal signal alone does not force a close', () => {
  const decision = decideAutoAiClose({
    invalidationDetected: false,
    invalidationSeverity: 'low',
    volatilityCollapsed: false,
    momentumStatus: 'stable',
  }, new Date('2026-07-14T15:00:00Z'));

  assert.equal(decision.close, false);
});

test('medium volatility collapse closes the trade before the 5 PM deadline', () => {
  const decision = decideAutoAiClose({
    volatilityCollapsed: true,
    volatilityCollapseSeverity: 'medium',
  }, new Date('2026-07-14T18:30:00Z'));

  assert.equal(decision.close, true);
  assert.equal(decision.category, 'volatility_slowdown');
});

test('momentum slowing is treated as volatility slowdown', () => {
  const decision = decideAutoAiClose({ momentumStatus: 'slowing' }, new Date('2026-07-14T20:30:00Z'));
  assert.equal(decision.close, true);
  assert.equal(decision.category, 'volatility_slowdown');
});

test('live V3 reversal adjustment closes without legacy invalidation', () => {
  const decision = decideAutoAiClose({
    invalidationDetected: false,
    liveTpConfidence: {
      adjustments: [{ label: 'M15 trend reversal', delta: -30 }],
    },
  }, new Date('2026-07-14T16:00:00Z'));

  assert.equal(decision.close, true);
  assert.equal(decision.category, 'reversal_risk');
});
