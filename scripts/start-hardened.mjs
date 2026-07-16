import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const port = Number(process.env.PORT || 8080);
const productionParts = [
  'hardening-patch.part00',
  'hardening-patch.part01',
  'hardening-patch.part02',
  'hardening-patch.part03',
  'hardening-patch.part04',
];

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

const result = spawnSync(process.execPath, ['--check', patchPath], {
  cwd: root,
  encoding: 'utf8',
  env: process.env,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`Production hardening patch syntax failed with exit code ${result.status}`);
}

const payload = JSON.stringify({
  ok: true,
  phase: 'production_patch_syntax_passed',
  tradingEnabled: false,
  productionParts,
});
http.createServer((req, res) => {
  res.statusCode = req.url === '/api/health' || req.url === '/health' || req.url === '/' ? 200 : 503;
  res.setHeader('content-type', 'application/json');
  res.end(payload);
}).listen(port, '0.0.0.0', () => {
  console.log(`[HARDENING_PROBE] production patch syntax passed; trading-disabled probe listening on ${port}`);
});
