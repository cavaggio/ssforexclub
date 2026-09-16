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

const structuralDetection = `const aGradeAutoContract = auto.includes('ictAGradePrecision');
const aGradeBaseQualificationPresent = auto.includes('isIctBaseQualified');
if (aGradeAutoContract && aGradeBaseQualificationPresent) {
  const baseStart = auto.indexOf('export function isIctBaseQualified');
  const baseEnd = baseStart >= 0
    ? auto.indexOf('\\n}\\n\\nexport function isIctAutoQualified', baseStart)
    : -1;
  if (baseStart >= 0 && baseEnd >= 0) {
    const baseBlock = auto.slice(baseStart, baseEnd + 2);
    const studyMarker = "    analysis?.marketMakerModel?.studyReady === true &&\\n";
    const confidenceMarker = '    Number.isFinite(confidence)';
    const gateStart = baseBlock.indexOf(studyMarker);
    const confidenceAt = gateStart >= 0 ? baseBlock.indexOf(confidenceMarker, gateStart) : -1;
    if (gateStart >= 0 && confidenceAt >= 0) {
      const strictGate =
        studyMarker +
        "    analysis?.marketMakerModel?.stage === 'DISTRIBUTION_ACTIVE' &&\\n" +
        confidenceMarker;
      const normalizedBase =
        baseBlock.slice(0, gateStart) +
        strictGate +
        baseBlock.slice(confidenceAt + confidenceMarker.length);
      auto = auto.slice(0, baseStart) + normalizedBase + auto.slice(baseEnd + 2);
    }
  }
}`;

const oldVerification = `if (aGradeAutoContract) {
  if (!auto.includes("analysis?.marketMakerModel?.stage === 'DISTRIBUTION_ACTIVE'")) {
    throw new Error('[ICT_MULTI_STRATEGY] A-grade Auto AI lost the required DISTRIBUTION_ACTIVE gate');
  }
} else if (auto.includes("analysis?.marketMakerModel?.stage === 'DISTRIBUTION_ACTIVE' &&\\n    Number.isFinite(confidence)")) {`;

const compatibleVerification = `if (aGradeAutoContract && aGradeBaseQualificationPresent) {
  if (!auto.includes("analysis?.marketMakerModel?.stage === 'DISTRIBUTION_ACTIVE'")) {
    throw new Error('[ICT_MULTI_STRATEGY] A-grade Auto AI lost the required DISTRIBUTION_ACTIVE gate');
  }
} else if (!aGradeAutoContract && auto.includes("analysis?.marketMakerModel?.stage === 'DISTRIBUTION_ACTIVE' &&\\n    Number.isFinite(confidence)")) {`;

let changed = false;
if (source.includes(literalDetection)) {
  source = source.replace(literalDetection, structuralDetection);
  changed = true;
} else if (!source.includes('const aGradeBaseQualificationPresent')) {
  throw new Error('[ICT_A_GRADE_COMPAT] multi-strategy A-grade detection marker not found');
}
if (source.includes(oldVerification)) {
  source = source.replace(oldVerification, compatibleVerification);
  changed = true;
}
if (changed) writeFileSync(target, source, 'utf8');
console.log('[ICT_A_GRADE_COMPAT] legacy multi-strategy pass defers final qualification authority to A-grade finalizer');
