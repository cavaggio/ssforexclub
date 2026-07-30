import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEngineTradeLearningPatch } from './apply_engine_trade_learning.mjs';
import { prepareEngineTradeLearningCompatibility } from './prepare_engine_trade_learning_compat.mjs';

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
  writeFileSync(join(root, 'server/ictExecution.js'), `
import { applyStoredStudyCalibration } from './dailyMarketStudy.js';
analysis = await applyStoredStudyCalibration(await analyze(pair), { client, engine: 'ict' });
`, 'utf8');
  writeFileSync(join(root, 'server/pprAutoTrade.js'), `
import { applyStoredStudyCalibration, runDailyMarketStudy } from './dailyMarketStudy.js';
const qualified = [];
applyStoredStudyCalibration(item, { client, engine: 'ppr' });
return {
      watchCandidates: scan?.watchCandidates || [],
};
`, 'utf8');
  writeFileSync(join(root, 'server/pprExecution.js'), `
import { applyStoredStudyCalibration } from './dailyMarketStudy.js';
const studiedSignal = await applyStoredStudyCalibration(fresh.signal, { client, engine: 'ppr' });
if (studiedSignal.direction !== originalDirection) return { allowed: false };
if (!(Number(studiedSignal.confidence) >= config.minConfidence)) {
  return { reason: 'confidence below threshold after daily-study calibration', studiedSignal };
}
return { allowed: true, signal: studiedSignal };
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
    signal = applyScalpMetadata({
      ...signal,
      ...refreshed.candidate,
      source: 'v3_pure_auto_ai',
    });
return {
      watchCandidates: stageWatchCandidates,
};
`, 'utf8');
  return root;
}

test('patches all engine scan and authoritative execution paths once', () => {
  const root = fixtureRoot();
  const expected = [
    'server/ictAutoTrade.js',
    'server/ictExecution.js',
    'server/pprAutoTrade.js',
    'server/pprExecution.js',
    'server/v3AutoTrade.js',
  ];
  const changed = applyEngineTradeLearningPatch(root);
  assert.deepEqual(changed.sort(), expected.sort());
  assert.equal(applyEngineTradeLearningPatch(root).length, 0);
  const combined = new Map(expected.map((relativePath) => [
    relativePath,
    readFileSync(join(root, relativePath), 'utf8'),
  ]));
  assert.equal(prepareEngineTradeLearningCompatibility(root).length, 4);
  applyEngineTradeLearningPatch(root);
  for (const [relativePath, content] of combined) {
    assert.equal(readFileSync(join(root, relativePath), 'utf8'), content, `${relativePath} drifted after compatibility round-trip`);
  }
  const ict = readFileSync(join(root, 'server/ictAutoTrade.js'), 'utf8');
  const ictExecution = readFileSync(join(root, 'server/ictExecution.js'), 'utf8');
  const ppr = readFileSync(join(root, 'server/pprAutoTrade.js'), 'utf8');
  const pprExecution = readFileSync(join(root, 'server/pprExecution.js'), 'utf8');
  const v3 = readFileSync(join(root, 'server/v3AutoTrade.js'), 'utf8');
  assert.match(ict, /signal: a/);
  assert.match(ict, /results: analyses/);
  assert.match(ictExecution, /applyCombinedLearningCalibration\(await analyze/);
  assert.match(ppr, /qualifiedCandidates: qualified/);
  assert.match(pprExecution, /combined market\/engine calibration/);
  assert.match(pprExecution, /signal: calibratedSignal/);
  assert.match(v3, /await applyCombinedLearningCalibration/);
  assert.match(v3, /authoritativeCandidate/);
  assert.match(v3, /rejected: scan\?\.rejected/);
});
