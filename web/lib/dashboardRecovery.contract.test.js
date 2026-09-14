import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const errorBoundary = readFileSync(new URL('../app/dashboard/error.tsx', import.meta.url), 'utf8');
const healthyMarker = readFileSync(new URL('../components/dashboard-recovery-marker.tsx', import.meta.url), 'utf8');
const recoveryPolicy = readFileSync(new URL('./dashboardRecovery.ts', import.meta.url), 'utf8');

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
