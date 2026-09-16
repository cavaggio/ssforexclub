import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const finalizer = path.join(ROOT, 'scripts/apply-ftmo-extended-qualification.mjs');
execFileSync(process.execPath, [finalizer], { cwd: ROOT, stdio: 'pipe' });

const route = fs.readFileSync(path.join(ROOT, 'app/api/cron/auto-ai-trading-extended/route.ts'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('extended Auto-AI scanner does not require MT5 readiness to qualify FTMO', () => {
  assert.match(route, /resolveActiveBrokerForUser\(row\.user_id, \{ requireExecutionReady: false \}\)/);
  assert.match(route, /ftmo_market_data_unavailable/);
  assert.match(route, /executionBroker: resolved\.activeBroker/);
  assert.match(route, /executionAccountId: credentials\.accountId/);
  assert.match(route, /executionTransport: resolved\.executionTransport \?\? 'http'/);
  assert.match(route, /qualificationIndependentOfMt5Readiness=true/);
  assert.match(route, /oandaExecutionFallback=false/);
  assert.doesNotMatch(
    route,
    /resolved\.brokerCredentialStatus !== 'ready' \|\| !resolved\.getCredentials \|\| !resolved\.baseUrl/,
  );
});

test('FTMO qualification finalizer runs after legacy web generators', () => {
  assert.match(
    String(packageJson.scripts?.['apply:web-runtime'] || ''),
    /apply:account-isolation && node scripts\/apply-ftmo-extended-qualification\.mjs$/,
  );
});
