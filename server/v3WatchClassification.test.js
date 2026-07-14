import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyV3WatchTier } from './v3WatchClassification.js';

const aligned = { passed: true, score: 100 };

test('wait_for_retest is Hot Watch even while execution quality is below threshold', () => {
  const result = classifyV3WatchTier({
    primaryAlignment: aligned,
    geometryValid: true,
    spreadOk: true,
    newsBlocked: false,
    entryTiming: { status: 'wait_for_retest' },
    stage1: { allowed: false },
    stage2: { allowed: true, state: 'ready' },
  });

  assert.equal(result.tier, 'hot');
});

test('too_early remains Near Watch', () => {
  const result = classifyV3WatchTier({
    primaryAlignment: aligned,
    geometryValid: true,
    spreadOk: true,
    newsBlocked: false,
    entryTiming: { status: 'too_early' },
    stage1: { allowed: true },
    stage2: { allowed: false, state: 'watch' },
  });

  assert.equal(result.tier, 'near');
});

test('setup passed and fresh trigger pending is Hot Watch', () => {
  const result = classifyV3WatchTier({
    primaryAlignment: aligned,
    geometryValid: true,
    spreadOk: true,
    newsBlocked: false,
    entryTiming: { status: 'valid_entry' },
    stage1: { allowed: true },
    stage2: { allowed: false, state: 'watch' },
  });

  assert.equal(result.tier, 'hot');
});

test('all setup trigger and timing gates passing is ready', () => {
  const result = classifyV3WatchTier({
    primaryAlignment: aligned,
    geometryValid: true,
    spreadOk: true,
    newsBlocked: false,
    entryTiming: { status: 'valid_entry' },
    stage1: { allowed: true },
    stage2: { allowed: true, state: 'ready' },
  });

  assert.equal(result.tier, 'ready');
});

test('news-blocked or alignment-failed candidates are not watched', () => {
  assert.equal(classifyV3WatchTier({
    primaryAlignment: aligned,
    geometryValid: true,
    spreadOk: true,
    newsBlocked: true,
    entryTiming: { status: 'wait_for_retest' },
    stage1: { allowed: true },
    stage2: { allowed: false, state: 'watch' },
  }).tier, 'none');

  assert.equal(classifyV3WatchTier({
    primaryAlignment: { passed: false, score: 33 },
    geometryValid: true,
    spreadOk: true,
    newsBlocked: false,
    entryTiming: { status: 'wait_for_retest' },
    stage1: { allowed: true },
    stage2: { allowed: false, state: 'watch' },
  }).tier, 'none');
});
