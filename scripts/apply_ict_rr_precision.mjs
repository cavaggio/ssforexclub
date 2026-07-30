#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function patch(relativePath, transform, markers = []) {
  const filePath = path.join(ROOT, relativePath);
  const before = fs.readFileSync(filePath, 'utf8');
  const after = transform(before);
  const missing = markers.filter((marker) => !after.includes(marker));
  if (missing.length) throw new Error(`${relativePath} missing ICT R:R precision markers: ${missing.join(', ')}`);
  if (after !== before) fs.writeFileSync(filePath, after);
  console.log(`[ICT_RR_PRECISION] verified ${relativePath}${after !== before ? ' (patched)' : ''}`);
}

patch(
  'server/ictEngine.js',
  (source) => source
    .replace(
      '  const executableRR = executableRisk > 0 ? executableReward / executableRisk : 0;',
      `  const executableRRRaw = executableRisk > 0 ? executableReward / executableRisk : 0;\n  // Compare at the same two-decimal precision presented to the user. This avoids\n  // rejecting values such as 1.4999999998 while the dashboard correctly shows 1.50.\n  const executableRR = Math.round((executableRRRaw + Number.EPSILON) * 100) / 100;`,
    )
    .replace(
      '  if (setup?.ok && executableRR < configuredIctMinRR()) hardFails.push(`Hard gate: executable R:R ${executableRR.toFixed(2)} is below ${configuredIctMinRR().toFixed(2)}.`);',
      `  const minimumExecutableRR = Math.round((configuredIctMinRR() + Number.EPSILON) * 100) / 100;\n  if (setup?.ok && executableRR < minimumExecutableRR) hardFails.push(\`Hard gate: executable R:R \${executableRR.toFixed(2)} is below \${minimumExecutableRR.toFixed(2)}.\`);`,
    ),
  ['const executableRRRaw =', 'const minimumExecutableRR ='],
);

patch(
  'server/ictTargetConfidence.js',
  (source) => source
    .replace(
      '  const rr = Math.max(0, finite(actualRR, 0));\n  const rrFloor = Math.max(1.5, finite(minimumRR, 1.5));',
      `  const rrRaw = Math.max(0, finite(actualRR, 0));\n  const rrFloorRaw = Math.max(1.5, finite(minimumRR, 1.5));\n  // Normalize both values to the displayed two-decimal contract before gating.\n  const rr = Math.round((rrRaw + Number.EPSILON) * 100) / 100;\n  const rrFloor = Math.round((rrFloorRaw + Number.EPSILON) * 100) / 100;`,
    ),
  ['const rrRaw =', 'const rrFloorRaw ='],
);

console.log('[ICT_RR_PRECISION] two-decimal R:R gate synchronized');
