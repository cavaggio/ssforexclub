import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'server', 'ictEngine.js');
const AUTO = path.join(ROOT, 'server', 'ictAutoTrade.js');
const EXECUTION = path.join(ROOT, 'server', 'ictExecution.js');
const EXECUTION_TEST = path.join(ROOT, 'server', 'ictExecution.test.js');

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`[ICT_MULTI_STRATEGY] missing ${label}`);
  return source.replace(before, () => after);
}

function replaceOptional(source, before, after) {
  if (source.includes(after) || !source.includes(before)) return source;
  return source.replace(before, () => after);
}

function insertAfter(source, anchor, addition, label) {
  if (source.includes(addition.trim())) return source;
  if (!source.includes(anchor)) throw new Error(`[ICT_MULTI_STRATEGY] missing ${label}`);
  return source.replace(anchor, () => `${anchor}${addition}`);
}

let engine = fs.readFileSync(ENGINE, 'utf8');
engine = insertAfter(
  engine,
  "import { classifyIctH1Momentum } from './ictH1Momentum.js';\n",
  "import { classifyIctEarlySessionDirection } from './ictEarlySessionDirection.js';\nimport { resolveIctStrategyAuthorization } from './ictStrategyRouter.js';\n",
  'engine strategy imports',
);

engine = insertAfter(
  engine,
  `  const h1Momentum = classifyIctH1Momentum({\n    h1Candles: h1,\n    bias: htfAligned ? dailyTfBias : null,\n    transition: h1Transition,\n  });\n`,
  `  const earlySessionDirection = classifyIctEarlySessionDirection({\n    h1Candles: h1,\n    bias: htfAligned ? dailyTfBias : null,\n    now,\n  });\n`,
  '01:00-03:00 ET H1 session profile',
);

engine = replaceOnce(
  engine,
  `  if (p.inducementSwept) c += 3;\n  c += Math.min(6, (p.labels || 0) * 3);`,
  `  if (p.inducementSwept) c += 3;\n  // 01:00/02:00/03:00 ET candles are one directional session narrative, not\n  // three separate confirmations. They may influence confidence but cannot\n  // override D1/H4 direction, H1 active momentum, or the fresh M5 trigger.\n  if (p.earlySessionAligned) c += 4;\n  else if (p.earlySessionOpposed) c -= 3;\n  c += Math.min(6, (p.labels || 0) * 3);`,
  'early-session confidence context',
);

engine = replaceOnce(
  engine,
  `  const entryAuthorization = marketMakerResolution.entryAuthorization;\n`,
  `  const strategyRouter = resolveIctStrategyAuthorization({\n    direction: want,\n    htfAligned,\n    h1Momentum,\n    h1Transition,\n    continuationBreakout,\n    marketMakerResolution,\n    earlySessionDirection,\n  });\n  const entryAuthorization = strategyRouter.entryAuthorization;\n`,
  'independent strategy authorization',
);

engine = replaceOnce(
  engine,
  "    hardFails.push(`Hard gate: central market-maker execution is not authorized — ${entryAuthorization.reason}`);",
  "    hardFails.push(`Hard gate: no ICT strategy is authorized — ${entryAuthorization.reason}`);",
  'strategy hard-gate wording',
);

engine = replaceOnce(
  engine,
  `    inducementSwept: inducement.inducementSwept, labels: labelCount,\n    rr: setup?.ok ? setup.rr : null,`,
  `    inducementSwept: inducement.inducementSwept, labels: labelCount,\n    earlySessionAligned: earlySessionDirection.alignedWithBias === true,\n    earlySessionOpposed: earlySessionDirection.opposesBias === true,\n    rr: setup?.ok ? setup.rr : null,`,
  'early-session confidence inputs',
);

engine = insertAfter(
  engine,
  "  if (h1Transition.ready) note(`H1 countertrend-to-${dailyTfBias} transition`);\n",
  "  if (earlySessionDirection.availableCount > 0) note(`01:00-03:00 ET H1 direction ${earlySessionDirection.direction}`);\n",
  'early-session concept note',
);

engine = insertAfter(
  engine,
  `  track(inducement.inducementSwept, 'inducement swept');\n`,
  `  if (earlySessionDirection.availableCount > 0) {\n    track(earlySessionDirection.alignedWithBias, '01:00-03:00 ET H1 direction');\n  }\n`,
  'early-session confluence diagnostic',
);

engine = replaceOnce(
  engine,
  `    h1Transition,\n    h1Momentum,\n    continuationBreakout,\n    entryAuthorization,`,
  `    h1Transition,\n    h1Momentum,\n    earlySessionDirection,\n    continuationBreakout,\n    strategyRouter,\n    entryAuthorization,`,
  'strategy diagnostics in engine response',
);

engine = replaceOnce(
  engine,
  `      entryAuthorization,\n    },\n    entryTimeframe: '5M',`,
  `      entryAuthorization,\n      nativeEntryAuthorization: marketMakerResolution.entryAuthorization,\n      selectedStrategy: strategyRouter.selectedStrategy,\n    },\n    entryTimeframe: '5M',`,
  'market-maker native versus selected authorization',
);

// Keep the early-session profile on the top-level analysis object, where the
// activity log and strategy router consume it. The nested `concepts.htf` object
// is rewritten by older generated-source passes, so patching that duplicate
// diagnostic is deliberately avoided to keep this transform idempotent.

engine = replaceOnce(
  engine,
  `    \`entryAuth=\${entryAuthorization.mode}\` +`,
  `    \`entryAuth=\${entryAuthorization.mode} strategy=\${strategyRouter.selectedStrategy || 'none'} earlyH1=\${earlySessionDirection.direction}\` +`,
  'strategy scan logging',
);

// Legacy direct-continuation logic allowed a continuation before the persistent
// PO3 cycle reached DISTRIBUTION_ACTIVE. The A-grade precision contract is
// intentionally stricter: when its two-stage qualification helper is present,
// preserve the universal current-day study + DISTRIBUTION_ACTIVE requirement.
let auto = fs.readFileSync(AUTO, 'utf8');
const aGradeAutoContract =
  auto.includes("from './ictAGradePrecision.js'") &&
  auto.includes('export function isIctBaseQualified') &&
  auto.includes("analysis?.marketMakerModel?.stage === 'DISTRIBUTION_ACTIVE'");
if (!aGradeAutoContract) {
  auto = replaceOnce(
    auto,
    `    analysis?.marketMakerModel?.studyReady === true &&\n    analysis?.marketMakerModel?.stage === 'DISTRIBUTION_ACTIVE' &&\n    Number.isFinite(confidence)`,
    `    analysis?.marketMakerModel?.studyReady === true &&\n    (analysis?.entryAuthorization?.requiresMarketMakerActive !== true ||\n      analysis?.marketMakerModel?.stage === 'DISTRIBUTION_ACTIVE') &&\n    Number.isFinite(confidence)`,
    'Auto AI strategy-specific market-maker gate',
  );
}
fs.writeFileSync(AUTO, auto);

let execution = fs.readFileSync(EXECUTION, 'utf8');
execution = replaceOnce(
  execution,
  "    return blocked(`ICT central market-maker authorization failed: ${entryAuthorization.reason || 'the persistent reversal/continuation cycle is not ready'}.`);",
  "    return blocked(`ICT strategy authorization failed: ${entryAuthorization.reason || 'no complete continuation or reversal strategy is ready'}.`);",
  'execution strategy authorization wording',
);
const aGradeExecutionContract =
  execution.includes("from './ictAGradePrecision.js'") ||
  execution.includes('ICT_A_GRADE_FRESH_THESIS_V1');
if (!aGradeExecutionContract) {
  execution = replaceOnce(
    execution,
    `  if (\n    analysis?.marketMakerModel?.studyReady !== true ||\n    analysis?.marketMakerModel?.stage !== 'DISTRIBUTION_ACTIVE'\n  ) {\n    return blocked('ICT execution requires a current-day 02:00 ET study and an activated persistent Power-of-Three distribution cycle.');\n  }`,
    `  if (analysis?.marketMakerModel?.studyReady !== true) {\n    return blocked('ICT execution requires the current-day 02:00 ET market study.');\n  }\n  const requiresMarketMakerActive = analysis?.entryAuthorization?.requiresMarketMakerActive === true;\n  if (requiresMarketMakerActive && analysis?.marketMakerModel?.stage !== 'DISTRIBUTION_ACTIVE') {\n    return blocked(\n      \`ICT \${analysis?.entryAuthorization?.strategy || analysis?.entryAuthorization?.family || 'market-maker'} strategy requires an activated persistent Power-of-Three distribution cycle.\`,\n    );\n  }`,
    'execution strategy-specific market-maker gate',
  );
}
fs.writeFileSync(EXECUTION, execution);

// Older generator passes append execution-smoke cases that assert the retired
// universal PO3 error text. Only rewrite those expectations for the legacy
// direct-continuation contract; A-grade keeps the stricter universal PO3 gate.
if (!aGradeExecutionContract && fs.existsSync(EXECUTION_TEST)) {
  let executionTest = fs.readFileSync(EXECUTION_TEST, 'utf8');
  executionTest = replaceOptional(
    executionTest,
    "assert.equal(r.reason, 'ICT execution requires a current-day 02:00 ET study and an activated persistent Power-of-Three distribution cycle.');",
    "assert.equal(r.reason, 'ICT market-maker strategy requires an activated persistent Power-of-Three distribution cycle.');",
  );
  executionTest = replaceOptional(
    executionTest,
    'assert.match(r.reason, /central market-maker authorization failed/i);',
    'assert.match(r.reason, /strategy authorization failed/i);',
  );
  fs.writeFileSync(EXECUTION_TEST, executionTest);
}

fs.writeFileSync(ENGINE, engine);

for (const required of [
  'resolveIctStrategyAuthorization',
  'classifyIctEarlySessionDirection',
  'earlySessionAligned: earlySessionDirection.alignedWithBias === true',
  'strategyRouter.entryAuthorization',
  'Hard gate: no ICT strategy is authorized',
  'ICT strategy authorization failed',
]) {
  const combined = `${engine}\n${auto}\n${execution}`;
  if (!combined.includes(required)) throw new Error(`[ICT_MULTI_STRATEGY] verification missing ${required}`);
}

if (aGradeAutoContract) {
  if (!auto.includes("analysis?.marketMakerModel?.stage === 'DISTRIBUTION_ACTIVE'")) {
    throw new Error('[ICT_MULTI_STRATEGY] A-grade Auto AI lost the required DISTRIBUTION_ACTIVE gate');
  }
} else if (auto.includes("analysis?.marketMakerModel?.stage === 'DISTRIBUTION_ACTIVE' &&\n    Number.isFinite(confidence)")) {
  throw new Error('[ICT_MULTI_STRATEGY] Auto AI still universally requires DISTRIBUTION_ACTIVE');
}

if (!aGradeExecutionContract && execution.includes('current-day 02:00 ET study and an activated persistent Power-of-Three distribution cycle')) {
  throw new Error('[ICT_MULTI_STRATEGY] executor still universally requires DISTRIBUTION_ACTIVE');
}
if (execution.includes('central market-maker authorization failed')) {
  throw new Error('[ICT_MULTI_STRATEGY] executor still describes strategy authorization as market-maker-only');
}

console.log(
  aGradeAutoContract
    ? 'ICT multi-strategy router applied with A-grade precision override: strategy diagnostics retained; DISTRIBUTION_ACTIVE remains mandatory.'
    : 'ICT multi-strategy router applied: direct continuation OR reversal/PO3, with 01:00-03:00 ET H1 session context.',
);