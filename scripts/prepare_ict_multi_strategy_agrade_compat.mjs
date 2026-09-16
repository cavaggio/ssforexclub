import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(ROOT, 'scripts/apply_ict_multi_strategy_router.mjs');
let source = readFileSync(target, 'utf8');

const literalDetection = `const aGradeAutoContract =
  auto.includes("from './ictAGradePrecision.js'") &&
  auto.includes('export function isIctBaseQualified') &&
  auto.includes("analysis?.marketMakerModel?.stage === 'DISTRIBUTION_ACTIVE'");`;

const structuralDetection = `const aGradeAutoContract =
  auto.includes('ictAGradePrecision') &&
  (auto.includes('isIctBaseQualified') ||
    auto.includes('withIctAGradeEvaluation') ||
    auto.includes('aGradeRejected'));`;

if (source.includes(literalDetection)) {
  source = source.replace(literalDetection, structuralDetection);
  writeFileSync(target, source, 'utf8');
  console.log('[ICT_A_GRADE_COMPAT] multi-strategy router now detects A-grade qualification structurally');
} else if (source.includes(structuralDetection)) {
  console.log('[ICT_A_GRADE_COMPAT] multi-strategy router already uses structural A-grade detection');
} else {
  throw new Error('[ICT_A_GRADE_COMPAT] multi-strategy A-grade detection marker not found');
}
