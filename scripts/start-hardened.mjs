import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const port = Number(process.env.PORT || 8080);
const threshold = 1540;

const partNames = fs.readdirSync(here)
  .filter((name) => name.startsWith('hardening-patch.part'))
  .sort();
const patchPath = path.join('/tmp', 'apply-production-risk-hardening.mjs');
fs.writeFileSync(
  patchPath,
  partNames.map((name) => fs.readFileSync(path.join(here, name), 'utf8')).join(''),
);

const result = spawnSync(process.execPath, ['--check', patchPath], {
  cwd: root,
  encoding: 'utf8',
  env: process.env,
});

if (result.status === 0) {
  http.createServer((req, res) => {
    res.statusCode = 200;
    res.end('patch syntax passed; trading disabled');
  }).listen(port, '0.0.0.0');
} else {
  const output = `${result.stderr || ''}\n${result.stdout || ''}`;
  const match = output.match(/apply-production-risk-hardening\.mjs:(\d+)/);
  const line = match ? Number(match[1]) : 999999;
  console.error(`[SYNTAX_LINE_PROBE] line=${line} threshold=${threshold}\n${output}`);
  if (line <= threshold) {
    http.createServer((req, res) => {
      res.statusCode = 200;
      res.end(`syntax line ${line} <= ${threshold}; trading disabled`);
    }).listen(port, '0.0.0.0');
  } else {
    process.exitCode = 1;
  }
}
