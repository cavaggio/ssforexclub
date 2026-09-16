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
    auto.includes('aGradeRejected'));
if (aGradeAutoContract) {
  const baseStart = auto.indexOf('export function isIctBaseQualified');
  const baseEnd = baseStart >= 0
    ? auto.indexOf('\\n}\\n\\nexport function isIctAutoQualified', baseStart)
    : -1;
  if (baseStart < 0 || baseEnd < 0) {
    throw new Error('[ICT_MULTI_STRATEGY] A-grade base qualification block is missing');
  }
  const baseBlock = auto.slice(baseStart, baseEnd + 2);
  const studyMarker = "    analysis?.marketMakerModel?.studyReady === true &&\\n";
  const confidenceMarker = '    Number.isFinite(confidence)';
  const gateStart = baseBlock.indexOf(studyMarker);
  const confidenceAt = gateStart >= 0 ? baseBlock.indexOf(confidenceMarker, gateStart) : -1;
  if (gateStart < 0 || confidenceAt < 0) {
    throw new Error('[ICT_MULTI_STRATEGY] A-grade market-maker qualification anchors are missing');
  }
  const strictGate =
    studyMarker +
    "    analysis?.marketMakerModel?.stage === 'DISTRIBUTION_ACTIVE' &&\\n" +
    confidenceMarker;
  const normalizedBase =
    baseBlock.slice(0, gateStart) +
    strictGate +
    baseBlock.slice(confidenceAt + confidenceMarker.length);
  auto = auto.slice(0, baseStart) + normalizedBase + auto.slice(baseEnd + 2);
}`;

if (source.includes(literalDetection)) {
  source = source.replace(literalDetection, structuralDetection);
  writeFileSync(target, source, 'utf8');
  console.log('[ICT_A_GRADE_COMPAT] multi-strategy router will restore the strict A-grade PO3 qualification gate');
} else if (source.includes("throw new Error('[ICT_MULTI_STRATEGY] A-grade base qualification block is missing')")) {
  console.log('[ICT_A_GRADE_COMPAT] multi-strategy router already restores the strict A-grade PO3 qualification gate');
} else {
  throw new Error('[ICT_A_GRADE_COMPAT] multi-strategy A-grade detection marker not found');
}
