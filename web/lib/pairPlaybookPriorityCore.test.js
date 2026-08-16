import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PAIR_PLAYBOOK_PRIORITY_POLICY_VERSION,
  buildPairPlaybookPriority,
  nyQuarterHourBucket,
} from './pairPlaybookPriorityCore.js';

function playbook(overrides = {}) {
  return {
    id: 'pb-1',
    pair: 'EUR_USD',
    version: 10,
    is_current: true,
    recommendation_stage: 'calibration_ready',
    sample_size: 157,
    win_rate: 95.48,
    expectancy_r: 1.58,
    profit_factor: 167.72,
    preferred_scalp_windows: [{ timeBucketEt: '03:45', direction: 'long', expectancyR: 2.12 }],
    ...overrides,
  };
}

test('nyQuarterHourBucket uses the current America/New_York 15-minute bucket', () => {
  assert.equal(nyQuarterHourBucket(new Date('2026-08-15T07:52:00Z')).bucketEt, '03:45');
});

test('selects only above-80% calibration-ready pairs in the matching ET window', () => {
  const profile = buildPairPlaybookPriority([
    playbook(),
    playbook({ id: 'pb-2', pair: 'GBP_USD', win_rate: 98.3, preferred_scalp_windows: [{ timeBucketEt: '04:30' }] }),
    playbook({ id: 'pb-3', pair: 'USD_JPY', win_rate: 80 }),
  ], new Date('2026-08-15T07:52:00Z'));

  assert.equal(profile.version, PAIR_PLAYBOOK_PRIORITY_POLICY_VERSION);
  assert.deepEqual(profile.selectedPairs, ['EUR_USD']);
  assert.equal(profile.eligibleCount, 2);
  assert.equal(profile.evaluations.find((item) => item.pair === 'USD_JPY').eligible, false);
  assert.match(profile.evaluations.find((item) => item.pair === 'USD_JPY').reasons.join(','), /not_above_80/);
});

test('ranks matching pairs without changing or bypassing execution gates', () => {
  const profile = buildPairPlaybookPriority([
    playbook({ id: 'a', pair: 'EUR_USD', win_rate: 91 }),
    playbook({ id: 'b', pair: 'GBP_USD', win_rate: 98 }),
    playbook({ id: 'c', pair: 'USD_JPY', win_rate: 88 }),
    playbook({ id: 'd', pair: 'AUD_USD', win_rate: 86 }),
  ], new Date('2026-08-15T07:52:00Z'));

  assert.deepEqual(profile.selectedPairs, ['GBP_USD', 'EUR_USD', 'USD_JPY']);
  assert.deepEqual(profile.safeguards, {
    confidenceFloorChanged: false,
    rrGateChanged: false,
    riskBypass: false,
    spreadBypass: false,
    newsBypass: false,
    marginBypass: false,
    duplicateBypass: false,
  });
});

test('fails safely when evidence is weak or outside the window', () => {
  const profile = buildPairPlaybookPriority([
    playbook({ sample_size: 49 }),
    playbook({ id: 'pb-2', pair: 'GBP_USD', preferred_scalp_windows: [{ timeBucketEt: '04:30' }] }),
  ], new Date('2026-08-15T07:52:00Z'));

  assert.equal(profile.enabled, false);
  assert.deepEqual(profile.selectedPairs, []);
  assert.match(profile.reason, /none match/i);
});

test('priority audit migration preserves exact account scope and gate safeguards', () => {
  const migration = readFileSync(
    new URL('../../supabase/migrations/20260815170000_pair_playbook_priority_audit.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /user_id text not null/);
  assert.match(migration, /broker_account_id text not null/);
  assert.match(migration, /ny_time_bucket text not null/);
  assert.match(migration, /selected_pairs jsonb/);
  assert.match(migration, /prescan_attempted boolean/);
  assert.match(migration, /never bypasses the native engine's confidence, R:R, risk, spread/);
});
