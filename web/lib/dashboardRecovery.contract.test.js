import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const errorBoundary = readFileSync(new URL('../app/dashboard/error.tsx', import.meta.url), 'utf8');
const healthyMarker = readFileSync(new URL('../components/dashboard-recovery-marker.tsx', import.meta.url), 'utf8');
const recoveryPolicy = readFileSync(new URL('./dashboardRecovery.ts', import.meta.url), 'utf8');
const dashboardPage = readFileSync(new URL('../app/dashboard/page.tsx', import.meta.url), 'utf8');
const sectionBoundary = readFileSync(new URL('../components/dashboard-section-error-boundary.tsx', import.meta.url), 'utf8');
const scannerCard = readFileSync(new URL('../components/scanner-status-card.tsx', import.meta.url), 'utf8');

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


test('dashboard isolates client widget failures instead of collapsing the entire route', () => {
  assert.match(dashboardPage, /DashboardSectionErrorBoundary label="Signal scanner"/);
  assert.match(dashboardPage, /DashboardSectionErrorBoundary label="Trade activity"/);
  assert.match(dashboardPage, /DashboardSectionErrorBoundary label="Auto AI controls"/);
  assert.match(sectionBoundary, /getDerivedStateFromError/);
  assert.match(sectionBoundary, /The rest of the dashboard remains available/);
});

test('scanner cards treat nullable broker and engine values as display fallbacks', () => {
  assert.match(scannerCard, /if \(value == null \|\| value === ''\) return null/);
  assert.match(scannerCard, /formatFixed\(signal\.lotSize, 4\)/);
  assert.match(scannerCard, /signal\.riskPercent != null/);
  assert.match(scannerCard, /Object\.entries\(signal\.scoreBreakdown \?\? \{\}\)/);
  assert.match(scannerCard, /trade\.updatedHoldWindow \?/);
  assert.doesNotMatch(scannerCard, /trade\.profitRMultiple !== undefined/);
  assert.doesNotMatch(scannerCard, /signal\.lotSize\.toFixed\(4\)/);
});
