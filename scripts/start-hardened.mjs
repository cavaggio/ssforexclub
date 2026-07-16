import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const port = Number(process.env.PORT || 8080);

function diagnosticServer(error) {
  const detail = {
    ok: false,
    hardening: 'failed_closed',
    tradingEnabled: false,
    error: error instanceof Error ? error.message : String(error),
    timestamp: new Date().toISOString(),
  };
  console.error('[HARDENING_BOOT] FAIL-CLOSED', detail);
  http.createServer((req, res) => {
    const isHealth = req.url === '/api/health' || req.url === '/health' || req.url === '/';
    res.statusCode = isHealth ? 200 : 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(detail));
  }).listen(port, '0.0.0.0', () => {
    console.error(`[HARDENING_BOOT] diagnostic-only server listening on ${port}`);
  });
}

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

try {
  const parts = fs.readdirSync(here)
    .filter((name) => name.startsWith('hardening-patch.part'))
    .sort()
    .map((name) => fs.readFileSync(path.join(here, name), 'utf8'));

  if (parts.length !== 8) {
    throw new Error(`Expected 8 production-hardening patch parts, found ${parts.length}`);
  }

  const patchPath = path.join('/tmp', 'apply-production-risk-hardening.mjs');
  fs.writeFileSync(patchPath, parts.join(''));

  console.log('[HARDENING_BOOT] validating patch');
  run(process.execPath, ['--check', patchPath], 'hardening patch syntax check');
  run(process.execPath, [patchPath], 'hardening patch application');

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
} catch (error) {
  diagnosticServer(error);
}
