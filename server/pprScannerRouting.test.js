import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAutoForUser } from './autoAiRouter.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('generated server source registers a read-only native PPR scan endpoint', () => {
  const patch = read('scripts/apply_ppr_engine.py');
  assert.match(patch, /app\.post\('\/api\/internal\/oanda\/ppr-scan'/);
  assert.match(patch, /scanPprMarket\(\{/);
  assert.match(patch, /legacyScannerUsed=false v3LogicUsed=false ictLogicUsed=false/);
  const routeSection = patch.split("app.post('/api/internal/oanda/ppr-scan'")[1].split("// POST /api/internal/oanda/ict")[0];
  assert.doesNotMatch(routeSection, /runAutoPprForUser|executePprTrade|runV3DashboardScan|scanForexPairs|analyzeICTPairs/);
});

test('root generation always reapplies PPR after every V3 generator', () => {
  const pkg = JSON.parse(read('package.json'));
  const command = pkg.scripts['apply:v3-entry'];
  assert.match(command, /scripts\/apply_ppr_engine\.py$/);
  assert.equal((command.match(/apply_ppr_engine\.py/g) || []).length, 1);
});

test('dashboard route takes engine from server settings, not request body', () => {
  const route = read('web/app/api/scanner/scan/route.ts');
  assert.match(route, /getUserTradingSettings\(userId\)/);
  assert.match(route, /settings\.autoAiEngine/);
  assert.match(route, /scanEndpointForEngine\(selectedEngine\)/);
  assert.doesNotMatch(route, /body\.engine|req\.body\?\.engine/);
});

test('PPR selected invokes only the PPR auto runner', async () => {
  const calls = [];
  const result = await runAutoForUser({
    client: { accountId: 'test-account' },
    engine: 'ppr',
    now: new Date('2026-07-17T13:00:00.000Z'),
    runIct: async () => { calls.push('ict'); return {}; },
    runV3: async () => { calls.push('v3'); return {}; },
    runPpr: async () => { calls.push('ppr'); return { scanned: 3 }; },
  });
  assert.deepEqual(calls, ['ppr']);
  assert.equal(result.engine, 'ppr');
  assert.equal(result.scanned, 3);
});

test('native PPR display component contains no foreign-engine display labels', () => {
  const component = read('web/components/native-engine-scan-panel.tsx');
  assert.doesNotMatch(component, /V3\.5|V3 shadow|WaterfallPanel|V3LiquidityPanel|macro badge/i);
  assert.match(component, /PPR — Price–Pool–Raid scan/);
  assert.match(component, /After 10:00 AM ET/);
});
