import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUTO = path.join(ROOT, 'server', 'ictAutoTrade.js');
let source = fs.readFileSync(AUTO, 'utf8');

if (!source.includes('ictAGradePrecision.js')) {
  const anchor = "import { routeIctExecutionClient } from './ftmoIctExecutionRouter.js';\n";
  if (!source.includes(anchor)) throw new Error('[ICT_A_GRADE_AUTO] FTMO router import anchor missing');
  source = source.replace(
    anchor,
    anchor + "import { evaluateIctAGradeSetup, ictAGradeConfig, recordIctAGradeDecision, withIctAGradeEvaluation } from './ictAGradePrecision.js';\n",
  );
}

const authoritativeHelpers = `export function isIctBaseQualified(analysis, cfg = ictExecConfig()) {
  const confidence = Number(analysis?.confidence);
  const rr = Number(analysis?.rr);
  const entryAuthorization = analysis?.entryAuthorization || {};
  const pairEligible = analysis?.pair
    ? isIctExecutionEligibleInstrument(analysis.pair)
    : analysis?.executionEligible !== false;
  return pairEligible &&
    analysis?.executionEligible !== false &&
    analysis?.signal !== 'none' &&
    analysis?.entryTimeframe === '5M' &&
    analysis?.entryCandle?.triggerReady === true &&
    analysis?.freshImpulse === true &&
    entryAuthorization.ready === true &&
    Boolean(entryAuthorization.cycleId) &&
    analysis?.correctiveGate?.passed === true &&
    analysis?.correctiveGate?.decision === 'authorize' &&
    analysis?.marketMakerModel?.studyReady === true &&
    analysis?.marketMakerModel?.stage === 'DISTRIBUTION_ACTIVE' &&
    Number.isFinite(confidence) && confidence >= cfg.minConfidence &&
    Number.isFinite(rr) && rr >= cfg.minRR;
}

export function isIctAutoQualified(analysis, cfg = ictExecConfig()) {
  if (!isIctBaseQualified(analysis, cfg)) return false;
  const gradeCfg = ictAGradeConfig();
  if (!gradeCfg.required) return true;
  const evaluation = analysis?.aGrade || evaluateIctAGradeSetup(analysis, { stage: 'scanner', config: gradeCfg });
  return evaluation?.passed === true;
}

`;

const baseStart = source.indexOf('export function isIctBaseQualified');
const autoStart = source.indexOf('export function isIctAutoQualified');
const runStart = source.indexOf('export async function runAutoAiForUser');
if (runStart < 0) throw new Error('[ICT_A_GRADE_AUTO] runAutoAiForUser anchor missing');
const helperStart = baseStart >= 0 ? baseStart : autoStart;
if (helperStart >= 0 && helperStart < runStart) {
  source = source.slice(0, helperStart) + authoritativeHelpers + source.slice(runStart);
} else {
  source = source.slice(0, runStart) + authoritativeHelpers + source.slice(runStart);
}

const runOffset = source.indexOf('export async function runAutoAiForUser');
const runTail = source.slice(runOffset);
if (!runTail.includes('const gradeCfg = ictAGradeConfig();')) {
  source = source.replace(
    '  const cfg = ictExecConfig();\n',
    '  const cfg = ictExecConfig();\n  const gradeCfg = ictAGradeConfig();\n',
  );
}

if (!source.includes('const baseQualified = analyses.filter((analysis) => isIctBaseQualified(analysis, cfg));')) {
  const qualifiedPatterns = [
    /  const qualified = analyses\.filter\(\(analysis\) => isIctAutoQualified\(analysis, cfg\)\);\n/,
    /  const qualified = analyses\.filter\(\(a\) => isIctAutoQualified\(a, cfg\)\);\n/,
  ];
  const replacement = `  const baseQualified = analyses.filter((analysis) => isIctBaseQualified(analysis, cfg));
  await Promise.all(baseQualified.map((analysis) => recordIctAGradeDecision({
    client,
    analysis,
    evaluation: analysis?.aGrade || evaluateIctAGradeSetup(analysis, { stage: 'scanner', config: gradeCfg }),
    stage: 'scanner',
    now,
  })));
  const qualified = baseQualified.filter((analysis) => {
    const evaluation = analysis?.aGrade || evaluateIctAGradeSetup(analysis, { stage: 'scanner', config: gradeCfg });
    analysis.aGrade = evaluation;
    return !gradeCfg.required || evaluation?.passed === true;
  });
`;
  let replaced = false;
  for (const pattern of qualifiedPatterns) {
    if (pattern.test(source)) {
      source = source.replace(pattern, replacement);
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    throw new Error('[ICT_A_GRADE_AUTO] could not locate final qualified-candidate filter');
  }
}

for (const marker of [
  'export function isIctBaseQualified',
  "marketMakerModel?.stage === 'DISTRIBUTION_ACTIVE'",
  'entryCandle?.triggerReady === true',
  'correctiveGate?.decision === \'authorize\'',
  'const gradeCfg = ictAGradeConfig();',
  'const baseQualified = analyses.filter((analysis) => isIctBaseQualified(analysis, cfg));',
]) {
  if (!source.includes(marker)) throw new Error(`[ICT_A_GRADE_AUTO] final contract missing ${marker}`);
}

fs.writeFileSync(AUTO, source);
console.log('ICT A-grade Auto AI final authority applied: strict 5M authorization + DISTRIBUTION_ACTIVE + 80+ setup-quality gate.');
