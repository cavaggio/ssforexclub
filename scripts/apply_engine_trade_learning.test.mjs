import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEngineTradeLearningPatch } from './apply_engine_trade_learning.mjs';

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'engine-learning-patch-'));
  mkdirSync(join(root, 'server'), { recursive: true });
  writeFileSync(join(root, 'server/ictAutoTrade.js'), `
import { applyStoredStudyCalibration, runDailyMarketStudy } from './dailyMarketStudy.js';
const analyses = await Promise.all(rawAnalyses.map((item) =>
  applyStoredStudyCalibration(item, { client, engine: 'ict' })
));
if (!qualified.length) return { scanned: analyses.length, qualified: 0, executed: [], skipped: [], ...watchState };
executed.push({ pair: a.pair, direction, tradeId: res.tradeId, units: res.units, holdMinutes: res.holdMinutes });
return { scanned: analyses.length, qualified: qualified.length, executed, skipped, ...watchState };
`, 'utf8');
  writeFileSync(join(root, 'server/pprAutoTrade.js'), `
import { applyStoredStudyCalibration, runDailyMarketStudy } from './dailyMarketStudy.js';
const qualified = [];
applyStoredStudyCalibration(item, { client, engine: 'ppr' });
return {
      watchCandidates: scan?.watchCandidates || [],
};
`, 'utf8');
  writeFileSync(join(root, 'server/v3AutoTrade.js'), `
import { applyScalpMetadata } from './scalpOnlyPolicy.js';
  const qualified = (Array.isArray(scan?.qualified) ? scan.qualified : []).map((signal) =>
    applyScalpMetadata({
      ...signal,
      source: 'v3_pure_auto_ai',
      strategy: 'V3',
      engine: 'v3',
      tradeStyle: 'SCALP',
      scalpOnly: true,
      selectedLogicType: 'v3_pure',
      architecture: 'independent_v3_raw_market_data',
    }),
  );
return {
      watchCandidates: stageWatchCandidates,
};
`, 'utf8');
  return root;
}

test('patches all engines once and remains idempotent', () => {
  const root = fixtureRoot();
  const changed = applyEngineTradeLearningPatch(root);
  assert.deepEqual(changed.sort(), ['server/ictAutoTrade.js', 'server/pprAutoTrade.js', 'server/v3AutoTrade.js']);
  assert.equal(applyEngineTradeLearningPatch(root).length, 0);
  const ict = readFileSync(join(root, 'server/ictAutoTrade.js'), 'utf8');
  const ppr = readFileSync(join(root, 'server/pprAutoTrade.js'), 'utf8');
  const v3 = readFileSync(join(root, 'server/v3AutoTrade.js'), 'utf8');
  assert.match(ict, /signal: a/);
  assert.match(ict, /results: analyses/);
  assert.match(ppr, /qualifiedCandidates: qualified/);
  assert.match(v3, /await applyCombinedLearningCalibration/);
  assert.match(v3, /rejected: scan\?\.rejected/);
});
