import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

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
    const detail = `${result.stderr || result.stdout || ''}`.trim().slice(-6000);
    throw new Error(`${label} failed with exit code ${result.status}${detail ? `: ${detail}` : ''}`);
  }
}

const parts = fs.readdirSync(here)
  .filter((name) => name.startsWith('hardening-patch.part'))
  .sort()
  .map((name) => fs.readFileSync(path.join(here, name), 'utf8'));

if (parts.length !== 8) {
  throw new Error(`Expected 8 production-hardening patch parts, found ${parts.length}`);
}

const riskManagerPath = path.join(root, 'server/riskManager.js');
const safetyPolicyPath = path.join(root, 'server/executionSafetyPolicy.js');
const alreadyApplied =
  fs.existsSync(safetyPolicyPath) &&
  fs.readFileSync(riskManagerPath, 'utf8').includes('DAILY_MAX_LOSS_PERCENT = 2.5') &&
  fs.readFileSync(riskManagerPath, 'utf8').includes('MAX_RISK_PER_TRADE_PERCENT = 1.25');

if (!alreadyApplied) {
  const patchPath = path.join('/tmp', 'apply-production-risk-hardening.mjs');
  fs.writeFileSync(patchPath, parts.join(''));
  console.log('[HARDENING_BOOT] validating and applying patch');
  run(process.execPath, ['--check', patchPath], 'hardening patch syntax check');
  run(process.execPath, [patchPath], 'hardening patch application');
} else {
  console.log('[HARDENING_BOOT] hardening already applied; skipping patch mutation');
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

console.log('[HARDENING_BOOT] patch and tests passed; starting trading server');
await import('../server/index.js');
