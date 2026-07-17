import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_AI_FULL_SCAN_INTERVAL_MS,
  AUTO_AI_HOT_TRIGGER_WATCH_INTERVAL_MS,
  AUTO_AI_NEAR_QUALIFIED_RECHECK_INTERVAL_MS,
  getAutoAiWatchState,
  inActiveTradeManagementWindow,
  inAutoAiWindow,
  stopAutoAiScheduler,
  updateWatchStateFromCronResponse,
} from './ictAutoScheduler.js';

test('auto-AI entry window: NY weekday 02:00–10:00 ET is open', () => {
  assert.equal(inAutoAiWindow(new Date('2026-06-09T06:00:00Z')), true); // 02:00 ET Tue
  assert.equal(inAutoAiWindow(new Date('2026-06-09T13:59:00Z')), true); // 09:59 ET Tue
});

test('auto-AI entry window: before 02:00 / at-or-after 10:00 ET is closed', () => {
  assert.equal(inAutoAiWindow(new Date('2026-06-09T05:59:00Z')), false); // 01:59 ET Tue
  assert.equal(inAutoAiWindow(new Date('2026-06-09T14:00:00Z')), false); // 10:00 ET Tue
  assert.equal(inAutoAiWindow(new Date('2026-06-09T18:00:00Z')), false); // 14:00 ET Tue
});

test('auto-AI entry window: weekends are closed even mid-window', () => {
  assert.equal(inAutoAiWindow(new Date('2026-06-06T13:00:00Z')), false); // 09:00 ET Saturday
  assert.equal(inAutoAiWindow(new Date('2026-06-07T13:00:00Z')), false); // 09:00 ET Sunday
});

test('active-trade management runs 10:00–17:30 ET on weekdays', () => {
  assert.equal(inActiveTradeManagementWindow(new Date('2026-06-09T13:59:00Z')), false); // 09:59 ET Tue
  assert.equal(inActiveTradeManagementWindow(new Date('2026-06-09T14:00:00Z')), true); // 10:00 ET Tue
  assert.equal(inActiveTradeManagementWindow(new Date('2026-06-09T21:29:00Z')), true); // 17:29 ET Tue
  assert.equal(inActiveTradeManagementWindow(new Date('2026-06-09T21:30:00Z')), false); // 17:30 ET Tue
  assert.equal(inActiveTradeManagementWindow(new Date('2026-06-06T16:00:00Z')), false); // Saturday
});

test('auto-AI scheduler intervals default to staged cadence', () => {
  assert.equal(AUTO_AI_FULL_SCAN_INTERVAL_MS, 120000);
  assert.equal(AUTO_AI_NEAR_QUALIFIED_RECHECK_INTERVAL_MS, 60000);
  assert.equal(AUTO_AI_HOT_TRIGGER_WATCH_INTERVAL_MS, 30000);
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
