import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAccountCalibrationSnapshot, expectedRForLifecycle } from './accountCalibrationCore.js';

test('expectedRForLifecycle prefers the stored entry expectation and falls back to geometry', () => {
  assert.equal(expectedRForLifecycle({ opening_snapshot: { item: { expectedRR: 2.4 } }, entry_price: 1, stop_loss: 0.9, take_profit: 1.2 }), 2.4);
  assert.equal(expectedRForLifecycle({ opening_snapshot: {}, entry_price: 1, stop_loss: 0.9, take_profit: 1.2 }), 2);
});

test('account calibration uses actual lifecycles and exposes candidate-level application proof', () => {
  const lifecycles = Array.from({ length: 10 }, (_, index) => ({
    state: 'closed',
    result: index < 7 ? 'win' : 'loss',
    closed_at: `2026-08-${String(index + 1).padStart(2, '0')}T12:00:00Z`,
    realized_r: index < 7 ? 2 : -1,
    opening_snapshot: { expectedRR: 2 },
    learning_audit_id: index < 2 ? `audit-${index}` : null,
    engine: 'ict',
  }));
  const snapshot = buildAccountCalibrationSnapshot({
    lifecycles,
    audits: [{ observed_at: '2026-08-15T12:00:00Z', engine: 'ict', pair: 'EUR_USD', original_confidence: 76, final_confidence: 77, combined_adjustment: 1 }],
    priorityAudit: { created_at: '2026-08-15T12:01:00Z', engine: 'ict', ny_time_bucket: '08:00', selected_pairs: ['EUR_USD'], prescan_attempted: true, prescan_ok: true },
    brokerAccountId: '101-001-12345678-001',
    environment: 'practice',
    computedAt: new Date('2026-08-15T12:02:00Z'),
  });

  assert.equal(snapshot.source, 'actual_trade_lifecycles');
  assert.equal(snapshot.accountScoped, true);
  assert.equal(snapshot.rolling.sampleCount, 10);
  assert.equal(snapshot.eligibleForAdjustment, true);
  assert.equal(snapshot.thresholdApplication, 'diagnostic_only');
  assert.equal(snapshot.executionApplication.appliedAtCandidateLevel, true);
  assert.equal(snapshot.executionApplication.adjustedCandidates, 1);
  assert.deepEqual(snapshot.playbookPriority.selectedPairs, ['EUR_USD']);
});

test('resolved trades without planned R remain visible but do not corrupt RR capture', () => {
  const snapshot = buildAccountCalibrationSnapshot({
    lifecycles: [{ state: 'closed', result: 'win', realized_r: 1.2, opening_snapshot: {} }],
  });
  assert.equal(snapshot.rolling.resolvedTradeCount, 1);
  assert.equal(snapshot.rolling.sampleCount, 0);
  assert.equal(snapshot.rolling.captureRatio, null);
});
