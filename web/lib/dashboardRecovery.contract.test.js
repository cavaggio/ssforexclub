import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const errorBoundary = readFileSync(new URL('../app/dashboard/error.tsx', import.meta.url), 'utf8');
const healthyMarker = readFileSync(new URL('../components/dashboard-recovery-marker.tsx', import.meta.url), 'utf8');
const recoveryPolicy = readFileSync(new URL('./dashboardRecovery.ts', import.meta.url), 'utf8');
const scannerCard = readFileSync(new URL('../components/scanner-status-card.tsx', import.meta.url), 'utf8');
const v3ActiveMonitor = readFileSync(new URL('../../server/v3ActiveTradeMonitor.js', import.meta.url), 'utf8');

test('dashboard stale-asset recovery recognizes current Next.js failure variants', () => {
  assert.match(recoveryPolicy, /React Client Manifest/);
  assert.match(recoveryPolicy, /_next\\\/static/);
  assert.match(recoveryPolicy, /Failed to \(\?:fetch dynamically imported module\|load/);
});

test('stale assets force a document reload while ordinary errors use reset', () => {
  assert.match(errorBoundary, /if \(staleAssetFailure\)[\s\S]*window\.location\.reload\(\)/);
  assert.match(errorBoundary, /reset\(\);/);
});

test('a stable dashboard clears the recovery guard for future deployments', () => {
  assert.match(healthyMarker, /HEALTHY_RENDER_DELAY_MS = 10_000/);
  assert.match(healthyMarker, /sessionStorage\.removeItem\(DASHBOARD_RECOVERY_KEY\)/);
  assert.match(healthyMarker, /window\.clearTimeout\(timer\)/);
});


test('dashboard normalizes volatile market payloads before rendering cards', () => {
  assert.match(scannerCard, /normalizeActiveTradesResponse\(json\.analysis\)/);
  assert.match(scannerCard, /normalizeReassessResponse\(json\.reassessment\)/);
  assert.match(scannerCard, /updatedHoldWindow:[\s\S]*minMinutes:/);
  assert.match(scannerCard, /if \(value == null \|\| value === ''\) return null/);
});

test('V3 active-trade payload preserves the shared dashboard contract', () => {
  assert.match(v3ActiveMonitor, /updatedHoldWindow: \{ minMinutes: 0, maxMinutes: 0, holdConfidence: 0 \}/);
  assert.match(v3ActiveMonitor, /timeDecayRisk: 'low'/);
  assert.match(v3ActiveMonitor, /waterfall: null/);
  assert.match(v3ActiveMonitor, /source: 'v3_native_live_tp_hit'/);
});
