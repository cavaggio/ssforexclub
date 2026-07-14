import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS,
  AUTO_AI_FULL_SCAN_INTERVAL_MS,
  AUTO_AI_HOT_TRIGGER_WATCH_INTERVAL_MS,
  AUTO_AI_NEAR_QUALIFIED_RECHECK_INTERVAL_MS,
  getAutoAiWatchState,
  inActiveTradeManagementWindow,
  inAutoAiWindow,
  stopAutoAiScheduler,
  updateWatchStateFromCronResponse,
} from './ictAutoScheduler.js';

test('Auto AI entry window is open from 02:15 through 13:59 ET', () => {
  assert.equal(inAutoAiWindow(new Date('2026-07-14T06:15:00Z')), true); // 02:15 ET
  assert.equal(inAutoAiWindow(new Date('2026-07-14T17:59:00Z')), true); // 13:59 ET
});

test('Auto AI stops opening new trades at 14:00 ET', () => {
  assert.equal(inAutoAiWindow(new Date('2026-07-14T06:14:00Z')), false); // 02:14 ET
  assert.equal(inAutoAiWindow(new Date('2026-07-14T18:00:00Z')), false); // 14:00 ET
  assert.equal(inAutoAiWindow(new Date('2026-07-14T20:00:00Z')), false); // 16:00 ET
});

test('active-trade management continues through the 5 PM ET sweep', () => {
  assert.equal(inActiveTradeManagementWindow(new Date('2026-07-14T17:59:00Z')), true); // 13:59 ET
  assert.equal(inActiveTradeManagementWindow(new Date('2026-07-14T21:00:00Z')), true); // 17:00 ET
  assert.equal(inActiveTradeManagementWindow(new Date('2026-07-14T21:05:00Z')), false); // 17:05 ET
});

test('entry and management windows are closed on weekends', () => {
  const saturday = new Date('2026-07-18T16:00:00Z');
  const sunday = new Date('2026-07-19T16:00:00Z');
  assert.equal(inAutoAiWindow(saturday), false);
  assert.equal(inActiveTradeManagementWindow(saturday), false);
  assert.equal(inAutoAiWindow(sunday), false);
  assert.equal(inActiveTradeManagementWindow(sunday), false);
});

test('Auto AI scheduler intervals use staged entry and five-minute management cadence', () => {
  assert.equal(AUTO_AI_FULL_SCAN_INTERVAL_MS, 120000);
  assert.equal(AUTO_AI_NEAR_QUALIFIED_RECHECK_INTERVAL_MS, 60000);
  assert.equal(AUTO_AI_HOT_TRIGGER_WATCH_INTERVAL_MS, 30000);
  assert.equal(ACTIVE_TRADE_MANAGEMENT_INTERVAL_MS, 300000);
});

test('near recheck cannot erase unrelated hot-watch pairs', () => {
  stopAutoAiScheduler();

  updateWatchStateFromCronResponse(JSON.stringify({
    nearQualifiedPairs: ['EUR_USD'],
    hotPairs: ['EUR_CHF'],
    lateEntryPairs: [],
  }), '[TEST][FULL]', 'full', []);

  updateWatchStateFromCronResponse(JSON.stringify({
    nearQualifiedPairs: [],
    hotPairs: ['EUR_USD'],
    lateEntryPairs: [],
  }), '[TEST][NEAR]', 'near_recheck', ['EUR_USD']);

  const state = getAutoAiWatchState();
  assert.deepEqual(state.nearQualifiedPairs, []);
  assert.deepEqual(new Set(state.hotPairs), new Set(['EUR_CHF', 'EUR_USD']));
});

test('hot-watch response removes only the hot pairs it actually rescanned', () => {
  updateWatchStateFromCronResponse(JSON.stringify({
    nearQualifiedPairs: [],
    hotPairs: [],
    lateEntryPairs: [],
  }), '[TEST][HOT]', 'hot_watch', ['EUR_CHF']);

  const state = getAutoAiWatchState();
  assert.deepEqual(state.hotPairs, ['EUR_USD']);
  stopAutoAiScheduler();
});
