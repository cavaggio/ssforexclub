import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const markerPath = path.join(root, 'server/.production-hardening-tested.json');

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stderr || result.stdout || ''}`.trim().slice(-8000);
    throw new Error(`${label} failed with exit code ${result.status}${detail ? `: ${detail}` : ''}`);
  }
}

const partNames = fs.readdirSync(here)
  .filter((name) => name.startsWith('hardening-patch.part'))
  .sort();
if (partNames.length !== 8) {
  throw new Error(`Expected 8 production-hardening patch parts, found ${partNames.length}`);
}

const riskManagerPath = path.join(root, 'server/riskManager.js');
const safetyPolicyPath = path.join(root, 'server/executionSafetyPolicy.js');
const riskSource = fs.existsSync(riskManagerPath) ? fs.readFileSync(riskManagerPath, 'utf8') : '';
const alreadyApplied =
  fs.existsSync(safetyPolicyPath) &&
  riskSource.includes('DAILY_MAX_LOSS_PERCENT = 2.5') &&
  riskSource.includes('MAX_RISK_PER_TRADE_PERCENT = 1.25');

if (!alreadyApplied) {
  const patchPath = path.join('/tmp', 'apply-production-risk-hardening.mjs');
  fs.writeFileSync(
    patchPath,
    partNames.map((name) => fs.readFileSync(path.join(here, name), 'utf8')).join(''),
  );
  console.log('[HARDENING_BUILD] validating and applying patch');
  run(process.execPath, ['--check', patchPath], 'hardening patch syntax check');
  run(process.execPath, [patchPath], 'hardening patch application');
} else {
  console.log('[HARDENING_BUILD] source is already hardened');
}

const changedSources = [
  'server/riskManager.js',
  'server/oandaRiskSizing.js',
  'server/tradeDecisionEngine.js',
  'server/executionSafetyPolicy.js',
  'server/v3QualityConfirmation.js',
  'server/v3IndependentScanner.js',
  'server/oandaTrade.js',
  'server/ictExecution.js',
];
for (const source of changedSources) {
  run(process.execPath, ['--check', source], `syntax check ${source}`);
}

run(process.execPath, [
  '--test',
  'server/riskManager.test.js',
  'server/executionSafetyPolicy.test.js',
  'server/v3QualityConfirmation.test.js',
  'server/v3IndependentScanner.test.js',
], 'production risk tests');

fs.writeFileSync(markerPath, JSON.stringify({
  ok: true,
  policy: 'risk-1.25-daily-2.5-entry-hardening-v1',
  testedAt: new Date().toISOString(),
  sourceFiles: changedSources,
}, null, 2));
console.log('[HARDENING_BUILD] patch, syntax checks, and production-risk tests passed');
