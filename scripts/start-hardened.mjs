import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const productionParts = [
  'hardening-patch.part00',
  'hardening-patch.part01',
  'hardening-patch.part02',
  'hardening-patch.part03',
  'hardening-patch.part04',
];

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

for (const name of productionParts) {
  if (!fs.existsSync(path.join(here, name))) {
    throw new Error(`Missing production hardening segment: ${name}`);
  }
}

const patchPath = path.join('/tmp', 'apply-production-risk-hardening.mjs');
fs.writeFileSync(
  patchPath,
  productionParts.map((name) => fs.readFileSync(path.join(here, name), 'utf8')).join(''),
);
run(process.execPath, ['--check', patchPath], 'production hardening patch syntax');
run(process.execPath, [patchPath], 'production hardening patch application');

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

console.log('[HARDENING_BOOT] production patch applied and verified; starting trading server');
await import('../server/index.js');
