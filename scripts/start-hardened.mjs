import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const markerPath = path.join(root, 'server/.production-hardening-tested.json');
const riskManagerPath = path.join(root, 'server/riskManager.js');
const safetyPolicyPath = path.join(root, 'server/executionSafetyPolicy.js');

if (!fs.existsSync(markerPath)) {
  throw new Error(
    'Production hardening was not tested during build. Refusing to start the trading server.',
  );
}

const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
const riskSource = fs.readFileSync(riskManagerPath, 'utf8');
const sourceVerified =
  marker?.ok === true &&
  marker?.policy === 'risk-1.25-daily-2.5-entry-hardening-v1' &&
  fs.existsSync(safetyPolicyPath) &&
  riskSource.includes('DAILY_MAX_LOSS_PERCENT = 2.5') &&
  riskSource.includes('MAX_RISK_PER_TRADE_PERCENT = 1.25');

if (!sourceVerified) {
  throw new Error('Production hardening marker/source verification failed. Refusing startup.');
}

console.log(
  `[HARDENING_BOOT] verified policy=${marker.policy} testedAt=${marker.testedAt}; starting trading server`,
);
await import('../server/index.js');
