import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(ROOT, 'scripts/apply_ict_runtime_gate_fix.mjs');
let source = readFileSync(target, 'utf8');

const legacy = `  if (!out.includes('confidence >= cfg.minConfidence') || !out.includes('rr >= cfg.minRR')) {
    throw new Error('[ICT_RUNTIME_GATE_FIX] ICT Auto AI qualification is not using the shared execution config');
  }`;

const compatible = `  const sharedExecutionConfig =
    (out.includes('confidence >= cfg.minConfidence') && out.includes('rr >= cfg.minRR')) ||
    (
      out.includes('ictExecConfig()') &&
      out.includes('cfg.minConfidence') &&
      out.includes('cfg.minRR') &&
      (out.includes('isIctBaseQualified') || out.includes('isIctAutoQualified'))
    );
  if (!sharedExecutionConfig) {
    throw new Error('[ICT_RUNTIME_GATE_FIX] ICT Auto AI qualification is not using the shared execution config');
  }`;

if (source.includes(legacy)) {
  source = source.replace(legacy, compatible);
  writeFileSync(target, source, 'utf8');
  console.log('[ICT_A_GRADE_COMPAT] runtime gate checker updated for two-stage base/A-grade qualification');
} else if (source.includes('const sharedExecutionConfig =')) {
  console.log('[ICT_A_GRADE_COMPAT] runtime gate checker already compatible');
} else {
  throw new Error('[ICT_A_GRADE_COMPAT] expected runtime gate checker marker not found');
}
