import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inAutoAiWindow } from './ictAutoScheduler.js';

// June 2026 is EDT (UTC-4). 2026-06-09 = Tuesday; 2026-06-06 = Saturday.

test('auto-AI window: NY weekday 02:00–11:00 ET is open', () => {
  assert.equal(inAutoAiWindow(new Date('2026-06-09T14:00:00Z')), true);  // 10:00 ET Tue
  assert.equal(inAutoAiWindow(new Date('2026-06-09T06:30:00Z')), true);  // 02:30 ET Tue
});

test('auto-AI window: before 02:00 / after 11:00 ET is closed', () => {
  assert.equal(inAutoAiWindow(new Date('2026-06-09T05:00:00Z')), false); // 01:00 ET Tue
  assert.equal(inAutoAiWindow(new Date('2026-06-09T16:00:00Z')), false); // 12:00 ET Tue
});

test('auto-AI window: weekends are closed even mid-window', () => {
  assert.equal(inAutoAiWindow(new Date('2026-06-06T14:00:00Z')), false); // 10:00 ET Saturday
  assert.equal(inAutoAiWindow(new Date('2026-06-07T14:00:00Z')), false); // 10:00 ET Sunday
});
