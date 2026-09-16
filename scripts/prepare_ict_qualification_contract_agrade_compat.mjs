import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(ROOT, 'scripts/apply_ict_qualification_contract.mjs');
let source = readFileSync(target, 'utf8');
let changed = false;

const requiredMarker = "  'requiresMarketMakerActive !== true',\n";
if (source.includes(requiredMarker)) {
  source = source.replace(requiredMarker, '');
  changed = true;
}

const universalAssertion = `if (auto.includes("analysis?.marketMakerModel?.stage === 'DISTRIBUTION_ACTIVE' &&\\n    Number.isFinite(confidence)")) {
  throw new Error('[ICT_QUALIFICATION_CONTRACT] Auto AI universally requires DISTRIBUTION_ACTIVE');
}`;
const compatibleAssertion = `const aGradeQualificationContract = auto.includes('ictAGradePrecision');
if (!aGradeQualificationContract && auto.includes("analysis?.marketMakerModel?.stage === 'DISTRIBUTION_ACTIVE' &&\\n    Number.isFinite(confidence)")) {
  throw new Error('[ICT_QUALIFICATION_CONTRACT] Auto AI universally requires DISTRIBUTION_ACTIVE');
}`;
if (source.includes(universalAssertion)) {
  source = source.replace(universalAssertion, compatibleAssertion);
  changed = true;
}

const logLine = "console.log('[ICT_QUALIFICATION_CONTRACT] restored 02:00 study, preserved 17:30 review, live window 02:30-10:30 ET, and strategy-specific qualification gates.');";
const compatibleLog = "console.log('[ICT_QUALIFICATION_CONTRACT] restored timing/study safeguards; A-grade finalizer remains authoritative for autonomous qualification.');";
if (source.includes(logLine)) {
  source = source.replace(logLine, compatibleLog);
  changed = true;
}

if (changed) writeFileSync(target, source, 'utf8');
if (!source.includes('aGradeQualificationContract')) {
  throw new Error('[ICT_A_GRADE_COMPAT] qualification-contract compatibility marker missing');
}
console.log('[ICT_A_GRADE_COMPAT] legacy qualification verifier now defers autonomous gate authority to the A-grade finalizer');
