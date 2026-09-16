import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(ROOT, 'scripts/apply_ict_qualification_contract.mjs');
let source = readFileSync(target, 'utf8');
let changed = false;

const legacyReplaceHelper = `function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(\`[ICT_QUALIFICATION_CONTRACT] missing \${label}\`);
  return source.replace(before, () => after);
}`;
const compatibleReplaceHelper = `function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) {
    const finalReversalDirection = source.includes("const reversalDirection = dailyTfBias !== 'neutral'") && source.includes('const reversalContext = !htfAligned && Boolean(want);');
    if (label === 'study-directed reversal bias' && finalReversalDirection) return source;
    if (label === 'strategy-family hard gates' && finalReversalDirection && source.includes("if (want && !kz.inKillzone) hardFails.push('Hard gate: no active ICT killzone/session.');")) return source;
    if (label === 'market-maker reversal direction gate' && source.includes("reason: 'No valid ICT trade direction is available.'")) return source;
    throw new Error(\`[ICT_QUALIFICATION_CONTRACT] missing \${label}\`);
  }
  return source.replace(before, () => after);
}`;
if (source.includes(legacyReplaceHelper)) {
  source = source.replace(legacyReplaceHelper, compatibleReplaceHelper);
  changed = true;
}

const requiredMarketMakerMarker = "  'requiresMarketMakerActive !== true',\n";
if (source.includes(requiredMarketMakerMarker)) {
  source = source.replace(requiredMarketMakerMarker, '');
  changed = true;
}

// The first generator pass may still contain the temporary studied-direction
// marker; after reversal hardening, the durable source contains reversalContext
// instead. Treat either as valid so the generator is truly idempotent without
// reintroducing the retired studiedReversalDirection shortcut.
const staleReversalRequired = "  'studiedReversalDirection: reversalStudyDirection',\n";
if (source.includes(staleReversalRequired)) {
  source = source.replace(staleReversalRequired, '');
  changed = true;
}
const requiredLoopAnchor = `];
for (const marker of required) {`;
const compatibleRequiredLoop = `];
const reversalDirectionContractPresent =
  combined.includes('studiedReversalDirection: reversalStudyDirection') ||
  combined.includes('const reversalContext = !htfAligned && Boolean(want);');
if (!reversalDirectionContractPresent) {
  throw new Error('[ICT_QUALIFICATION_CONTRACT] verification missing reversal-direction contract');
}
for (const marker of required) {`;
if (source.includes(requiredLoopAnchor) && !source.includes('reversalDirectionContractPresent')) {
  source = source.replace(requiredLoopAnchor, compatibleRequiredLoop);
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

const legacyMarketMakerReplace = `marketMaker = replaceOnce(
  marketMaker,
  \`  if (!direction || observation?.htfAligned !== true) {\\n    return {\\n      cycle: context?.cycle ?? null,\\n      changed: false,\\n      entryAuthorization: {\\n        ...baseAuthorization,\\n        reason: 'Daily and H4 do not provide an aligned market-maker direction.',\\n      },\\n    };\\n  }\`,
  \`  const studiedReversalDirection = observation?.studiedReversalDirection === true;\\n  if (!direction || (observation?.htfAligned !== true && !studiedReversalDirection)) {\\n    return {\\n      cycle: context?.cycle ?? null,\\n      changed: false,\\n      entryAuthorization: {\\n        ...baseAuthorization,\\n        reason: 'No valid continuation alignment or current-day studied reversal direction is available.',\\n      },\\n    };\\n  }\`,
  'market-maker reversal direction gate',
);`;

const idempotentMarketMakerReplace = `const finalMarketMakerDirectionGate = \`  if (!direction) {\\n    return {\\n      cycle: context?.cycle ?? null,\\n      changed: false,\\n      entryAuthorization: {\\n        ...baseAuthorization,\\n        reason: 'No valid ICT trade direction is available.',\\n      },\\n    };\\n  }\`;
if (!marketMaker.includes(finalMarketMakerDirectionGate)) {
  marketMaker = replaceOnce(
    marketMaker,
    \`  if (!direction || observation?.htfAligned !== true) {\\n    return {\\n      cycle: context?.cycle ?? null,\\n      changed: false,\\n      entryAuthorization: {\\n        ...baseAuthorization,\\n        reason: 'Daily and H4 do not provide an aligned market-maker direction.',\\n      },\\n    };\\n  }\`,
    \`  const studiedReversalDirection = observation?.studiedReversalDirection === true;\\n  if (!direction || (observation?.htfAligned !== true && !studiedReversalDirection)) {\\n    return {\\n      cycle: context?.cycle ?? null,\\n      changed: false,\\n      entryAuthorization: {\\n        ...baseAuthorization,\\n        reason: 'No valid continuation alignment or current-day studied reversal direction is available.',\\n      },\\n    };\\n  }\`,
    'market-maker reversal direction gate',
  );
}`;
if (source.includes(legacyMarketMakerReplace)) {
  source = source.replace(legacyMarketMakerReplace, idempotentMarketMakerReplace);
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
if (!source.includes('finalMarketMakerDirectionGate')) {
  throw new Error('[ICT_A_GRADE_COMPAT] idempotent market-maker direction compatibility marker missing');
}
if (!source.includes('finalReversalDirection')) {
  throw new Error('[ICT_A_GRADE_COMPAT] idempotent reversal-direction compatibility marker missing');
}
if (!source.includes('reversalDirectionContractPresent')) {
  throw new Error('[ICT_A_GRADE_COMPAT] reversal-direction verification compatibility marker missing');
}
console.log('[ICT_A_GRADE_COMPAT] legacy qualification verifier is idempotent and defers autonomous gate authority to the A-grade finalizer');
