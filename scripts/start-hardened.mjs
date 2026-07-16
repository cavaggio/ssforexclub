import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const port = Number(process.env.PORT || 8080);

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env: process.env });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stderr || result.stdout || ''}`.trim().slice(-6000);
    throw new Error(`${label} failed with exit code ${result.status}${detail ? `: ${detail}` : ''}`);
  }
}

const partNames = fs.readdirSync(here)
  .filter((name) => name.startsWith('hardening-patch.part'))
  .sort();
if (partNames.length !== 7) throw new Error(`Expected 7 patch parts, found ${partNames.length}`);

const patchPath = path.join('/tmp', 'apply-production-risk-hardening.mjs');
fs.writeFileSync(
  patchPath,
  partNames.map((name) => fs.readFileSync(path.join(here, name), 'utf8')).join(''),
);
run(process.execPath, ['--check', patchPath], 'assembled patch syntax check');

const payload = JSON.stringify({
  ok: true,
  phase: 'probe_patch_syntax_passed',
  tradingEnabled: false,
  parts: partNames,
});
http.createServer((req, res) => {
  res.statusCode = req.url === '/api/health' || req.url === '/health' || req.url === '/' ? 200 : 503;
  res.setHeader('content-type', 'application/json');
  res.end(payload);
}).listen(port, '0.0.0.0', () => {
  console.log(`[HARDENING_PROBE] patch syntax passed; trading-disabled probe listening on ${port}`);
});
