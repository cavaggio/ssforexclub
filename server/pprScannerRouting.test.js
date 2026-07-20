import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAutoForUser } from './autoAiRouter.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('generated server source scans natively and conditionally executes every qualified PPR signal', () => {
  const index = read('server/index.js');
  assert.match(index, /app\.post\('\/api\/internal\/oanda\/ppr-scan'/);
  assert.match(index, /import \{ scanPprMarket \} from '\.\/pprEngine\.js'/);
  assert.match(index, /import \{ executePprTrade \} from '\.\/pprExecution\.js'/);
  const routeSection = index
    .split("app.post('/api/internal/oanda/ppr-scan'")[1]
    .split('// POST /api/internal/oanda/ict')[0];
  assert.match(routeSection, /scanPprMarket\(\{/);
  assert.match(routeSection, /const autoExecute = req\.body\?\.autoExecute === true/);
  assert.match(routeSection, /for \(const signal of qualified\)/);
  assert.match(routeSection, /executePprTrade\(signal/);
  assert.match(routeSection, /allQualifiedAttempted/);
  assert.match(routeSection, /legacyScannerUsed=false v3LogicUsed=false ictLogicUsed=false/);
  assert.doesNotMatch(routeSection, /runAutoPprForUser|runV3DashboardScan|scanForexPairs|analyzeICTPairs/);
});

test('root generation reapplies PPR execution patch before the final isolation pass', () => {
  const pkg = JSON.parse(read('package.json'));
  const command = pkg.scripts['apply:v3-entry'];
  const pprIndex = command.indexOf('scripts/apply_ppr_engine.py');
  const qualifiedExecutionIndex = command.indexOf('scripts/apply_qualified_scan_execution.py');
  const isolationIndex = command.indexOf('scripts/enforce_engine_isolation.py');
  assert.ok(pprIndex >= 0);
  assert.ok(qualifiedExecutionIndex > pprIndex);
  assert.ok(isolationIndex > qualifiedExecutionIndex);
  assert.equal((command.match(/apply_ppr_engine\.py/g) || []).length, 1);
  assert.equal((command.match(/apply_qualified_scan_execution\.py/g) || []).length, 1);
  assert.equal((command.match(/enforce_engine_isolation\.py/g) || []).length, 1);
});

test('dashboard route takes engine from server settings and auto-executes only enabled PPR', () => {
  const route = read('web/app/api/scanner/scan/route.ts');
  assert.match(route, /getUserTradingSettings\(userId\)/);
  assert.match(route, /settings\.autoAiEngine/);
  assert.match(route, /settings\.autoAiTradingEnabled/);
  assert.match(route, /scanEndpointForEngine\(selectedEngine\)/);
  assert.match(route, /autoAiTradingEnabled && selectedEngine === 'ppr'/);
  assert.match(route, /autoExecute,/);
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
