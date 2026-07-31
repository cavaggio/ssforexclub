import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function replaceRequired(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`[ICT_RUNTIME_GATE_FIX] missing ${label}`);
  return source.replace(before, after);
}

function patchRuntimeStart(source) {
  const after = source
    .replaceAll('ICT_MIN_CONFIDENCE', 'ICT_EXECUTION_MIN_CONFIDENCE')
    .replaceAll('Math.max(93', 'Math.max(80')
    .replaceAll("'93'", "'80'");

  const required = [
    'process.env.ICT_EXECUTION_MIN_CONFIDENCE = String(Math.max(80,',
    "Math.max(80, parseFloat(process.env.ICT_EXECUTION_MIN_CONFIDENCE || '80'))",
  ];
  const missing = required.filter((marker) => !after.includes(marker));
  if (missing.length) {
    throw new Error(`[ICT_RUNTIME_GATE_FIX] runtime start missing markers: ${missing.join(', ')}`);
  }
  if (after.includes('Math.max(93') || after.includes("|| '93'")) {
    throw new Error('[ICT_RUNTIME_GATE_FIX] runtime start still contains the retired 93% ICT floor');
  }
  return after;
}

function patchEngine(source) {
  let out = source;
  out = out.replace(
    "    // Math.max(80, parseFloat(process.env.ICT_MIN_CONFIDENCE || '80')) is retained as a build-alignment marker.\n",
    "    // Operational ICT qualification floor. Use the new execution-specific variable\n" +
      "    // only when an intentionally stricter floor is required.\n",
  );
  out = replaceRequired(
    out,
    "    minConfidence: Math.max(93, parseFloat(process.env.ICT_MIN_CONFIDENCE || '93')),",
    "    minConfidence: Math.max(80, parseFloat(process.env.ICT_EXECUTION_MIN_CONFIDENCE || '80')),",
    'ICT scanner confidence floor',
  );
  return out;
}

function patchAutoTrade(source) {
  let out = source;
  out = out.replace(
    /((?:export\s+)?function buildIctWatchState\(analyses = \[\], minConfidence = )93(, minRR = 1\.5\))?/,
    (_, prefix, minRrSuffix = '') => `${prefix}80${minRrSuffix}`,
  );
  out = out.replaceAll('confidence >= 93 && rr >= 1.5', 'confidence >= 80 && rr >= 1.5');
  if (!out.includes('minConfidence = 80')) {
    throw new Error('[ICT_RUNTIME_GATE_FIX] ICT Auto AI watch-state floor was not normalized to 80%');
  }
  if (!out.includes('confidence >= cfg.minConfidence') || !out.includes('rr >= cfg.minRR')) {
    throw new Error('[ICT_RUNTIME_GATE_FIX] ICT Auto AI qualification is not using the shared execution config');
  }
  return out;
}

function patchExecution(source) {
  let out = source;
  out = replaceRequired(
    out,
    "import { repriceIctTargetHitConfidence } from './ictTargetConfidence.js';\n",
    "import { repriceIctTargetHitConfidence } from './ictTargetConfidence.js';\n" +
      "import { maybeRebaseIctTarget } from './ictExecutionTarget.js';\n",
    'ICT executable-target import',
  );
  out = replaceRequired(
    out,
    "    minConfidence: Math.max(93, Number(rawConfig?.minConfidence) || 93),",
    "    minConfidence: Math.max(80, Number(rawConfig?.minConfidence) || 80),",
    'ICT executor confidence floor',
  );
  out = out.replace(
    '  // Auto execution confidence floor (≥90) — central, applies to autonomous runs.',
    '  // Auto execution uses the authoritative ICT floor (80 by default).',
  );

  const oldConfirmation = `  const executablePrice = direction === 'long' ? protectiveCheck.ask : protectiveCheck.bid;
  const finalTargetConfidence = repriceIctTargetHitConfidence({
    analysis,
    pair,
    direction,
    executablePrice,
    spreadPips: freshSpreadPips,
    maxSpreadPips: maxFreshSpreadPips,
    minConfidence: config.minConfidence,
  });
  if (!finalTargetConfidence.eligible || finalTargetConfidence.confidence < config.minConfidence) {
    return blocked(
      \`Final executable-price target-hit confirmation rejected: \${finalTargetConfidence.blockers.join('; ') || 'confidence gate failed'}.\`,
      { finalTargetConfidence },
    );
  }
  entry = executablePrice;
  analysis = {
    ...analysis,
    entry,
    rr: finalTargetConfidence.actualRR,
    confidence: finalTargetConfidence.confidence,
    targetHitConfidence: finalTargetConfidence.confidence,
    targetConfidence: finalTargetConfidence,
  };
`;

  const newConfirmation = `  const executablePrice = direction === 'long' ? protectiveCheck.ask : protectiveCheck.bid;
  let finalAnalysis = analysis;
  let finalTargetConfidence = repriceIctTargetHitConfidence({
    analysis: finalAnalysis,
    pair,
    direction,
    executablePrice,
    spreadPips: freshSpreadPips,
    maxSpreadPips: maxFreshSpreadPips,
    minConfidence: config.minConfidence,
  });

  // A scanner-qualified 1.50R setup must not be rejected because the fresh ask
  // or bid moved a fraction of a pip. Preserve the floor by moving TP only when
  // both the R shortfall and the required target extension remain tightly bounded.
  const executionTargetRebase = maybeRebaseIctTarget({
    pair,
    direction,
    executablePrice,
    stopLoss,
    currentTarget: targetProfit,
    scannerRR: Number(analysis.rr ?? analysis.targetConfidence?.actualRR ?? 0),
    executableRR: finalTargetConfidence.actualRR,
    minimumRR: Number(config.minRR ?? analysis.minimumRR ?? 1.5),
    maxShortfallR: Number(process.env.ICT_EXECUTION_RR_REBASE_TOLERANCE || 0.10),
    maxExtensionPips: Number(process.env.ICT_EXECUTION_TARGET_REBASE_MAX_PIPS || 2),
  });
  if (executionTargetRebase.adjusted) {
    targetProfit = executionTargetRebase.targetProfit;
    finalAnalysis = {
      ...analysis,
      target1: targetProfit,
      takeProfit: targetProfit,
      executionTargetRebase,
    };
    finalTargetConfidence = repriceIctTargetHitConfidence({
      analysis: finalAnalysis,
      pair,
      direction,
      executablePrice,
      spreadPips: freshSpreadPips,
      maxSpreadPips: maxFreshSpreadPips,
      minConfidence: config.minConfidence,
    });
    rec(
      \`Fresh quote reduced R:R to \${executionTargetRebase.executableRR.toFixed(2)}; \` +
      \`TP rebased \${executionTargetRebase.extensionPips.toFixed(2)}p to preserve \` +
      \`\${executionTargetRebase.minimumRR.toFixed(2)}R.\`,
    );
  }

  if (!finalTargetConfidence.eligible || finalTargetConfidence.confidence < config.minConfidence) {
    return blocked(
      \`Final executable-price target-hit confirmation rejected: \${finalTargetConfidence.blockers.join('; ') || 'confidence gate failed'}.\`,
      { finalTargetConfidence, executionTargetRebase },
    );
  }
  entry = executablePrice;
  analysis = {
    ...finalAnalysis,
    entry,
    target1: targetProfit,
    takeProfit: targetProfit,
    rr: finalTargetConfidence.actualRR,
    confidence: finalTargetConfidence.confidence,
    targetHitConfidence: finalTargetConfidence.confidence,
    targetConfidence: finalTargetConfidence,
    executionTargetRebase,
  };
`;

  out = replaceRequired(
    out,
    oldConfirmation,
    newConfirmation,
    'final executable-price confirmation block',
  );
  return out;
}

export function applyIctRuntimeGateFix(root = DEFAULT_ROOT) {
  const targets = [
    ['scripts/runtime_execution_start.mjs', patchRuntimeStart, true],
    ['server/ictEngine.js', patchEngine, false],
    ['server/ictAutoTrade.js', patchAutoTrade, false],
    ['server/ictExecution.js', patchExecution, false],
  ];
  const changed = [];
  for (const [relativePath, patcher, optional] of targets) {
    const path = resolve(root, relativePath);
    if (optional && !existsSync(path)) continue;
    const before = readFileSync(path, 'utf8');
    const after = patcher(before);
    if (after !== before) {
      writeFileSync(path, after, 'utf8');
      changed.push(relativePath);
    }
    console.log(`[ICT_RUNTIME_GATE_FIX] verified ${relativePath}${after !== before ? ' (patched)' : ''}`);
  }
  return changed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  applyIctRuntimeGateFix();
}
