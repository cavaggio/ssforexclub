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
    .replaceAll('Math.max(93', 'Math.max(75')
    .replaceAll('Math.max(80', 'Math.max(75')
    .replaceAll("'93'", "'75'")
    .replaceAll("'80'", "'75'");

  const required = [
    'process.env.ICT_EXECUTION_MIN_CONFIDENCE = String(Math.max(75,',
    "Math.max(75, parseFloat(process.env.ICT_EXECUTION_MIN_CONFIDENCE || '75'))",
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
    "    // Math.max(75, parseFloat(process.env.ICT_MIN_CONFIDENCE || '75')) is retained as a build-alignment marker.\n",
    "    // Operational ICT qualification floor. Use the new execution-specific variable\n" +
      "    // only when an intentionally stricter floor is required.\n",
  );
  if (!out.includes('    minConfidence: 75,')) {
    out = replaceRequired(
      out,
      "    minConfidence: Math.max(93, parseFloat(process.env.ICT_MIN_CONFIDENCE || '93')),",
      "    minConfidence: Math.max(75, parseFloat(process.env.ICT_EXECUTION_MIN_CONFIDENCE || '75')),",
      'ICT scanner confidence floor',
    );
  }
  return out;
}

function patchAutoTrade(source) {
  let out = source;
  out = out.replace(
    /((?:export\s+)?function buildIctWatchState\(analyses = \[\], minConfidence = )93(, minRR = 1\.5\))?/,
    (_, prefix, minRrSuffix = '') => `${prefix}75${minRrSuffix}`,
  );
  out = out.replaceAll('confidence >= 93 && rr >= 1.5', 'confidence >= 75 && rr >= 1.5');
  out = out.replaceAll('confidence >= 80 && rr >= 1.5', 'confidence >= 75 && rr >= 1.5');
  if (!out.includes('minConfidence = 75')) {
    throw new Error('[ICT_RUNTIME_GATE_FIX] ICT Auto AI watch-state floor was not normalized to 75%');
  }
  if (!out.includes('confidence >= cfg.minConfidence') || !out.includes('rr >= cfg.minRR')) {
    throw new Error('[ICT_RUNTIME_GATE_FIX] ICT Auto AI qualification is not using the shared execution config');
  }
  return out;
}

function patchExecution(source) {
  let out = source;
  const executionTargetImport = "import { maybeRebaseIctTarget, selectIctPairQuote } from './ictExecutionTarget.js';";
  if (!out.includes(executionTargetImport)) {
    out = replaceRequired(
      out,
      "import { repriceIctTargetHitConfidence } from './ictTargetConfidence.js';\n",
      "import { repriceIctTargetHitConfidence } from './ictTargetConfidence.js';\n" +
        `${executionTargetImport}\n`,
      'ICT executable-target import',
    );
  }
  out = out.replace(
    "import { maybeRebaseIctTarget } from './ictExecutionTarget.js';",
    executionTargetImport,
  );
  while (out.split(executionTargetImport).length - 1 > 1) {
    out = out.replace(`\n${executionTargetImport}`, '');
  }
  if (!out.includes('    minConfidence: 75,')) {
    out = replaceRequired(
      out,
      "    minConfidence: Math.max(93, Number(rawConfig?.minConfidence) || 93),",
      "    minConfidence: Math.max(75, Number(rawConfig?.minConfidence) || 75),",
      'ICT executor confidence floor',
    );
  }
  out = out.replace(
    '  // Auto execution confidence floor (≥90) — central, applies to autonomous runs.',
    '  // Auto execution uses the authoritative ICT floor (75 by default).',
  );

  // The final market-side entry is authoritative for risk sizing. These values
  // are recalculated after the fresh quote and any bounded TP rebase.
  out = out
    .replace('  const slPips = +(Math.abs(entry - stopLoss) / pipSize).toFixed(1);',
      '  let slPips = +(Math.abs(entry - stopLoss) / pipSize).toFixed(1);')
    .replace('  const tpPips = +(Math.abs(targetProfit - entry) / pipSize).toFixed(1);',
      '  let tpPips = +(Math.abs(targetProfit - entry) / pipSize).toFixed(1);')
    .replace('  const sizing = computeFixedDollarSizing({',
      '  let sizing = computeFixedDollarSizing({')
    .replace('  const units = sizing.signedUnits;',
      '  let units = sizing.signedUnits;');

  // A target that is still on the correct side of the quote can be safely
  // extended by the executable-R:R policy below. Do not reject it before that
  // policy runs merely because it is inside the generic two-pip buffer.
  out = out.replace(
    "    ? stopLoss < executable - minBuffer && targetProfit > executable + minBuffer\n    : stopLoss > executable + minBuffer && targetProfit < executable - minBuffer;",
    "    ? stopLoss < executable - minBuffer && targetProfit > executable\n    : stopLoss > executable + minBuffer && targetProfit < executable;",
  );

  const oldQuoteSelection = `    freshQuote = Array.isArray(pricingPayload)
      ? pricingPayload[0]
      : pricingPayload?.prices?.[0] || pricingPayload?.[pair] || pricingPayload;
`;
  const newQuoteSelection = `    const pairQuoteSelection = selectIctPairQuote(pricingPayload, pair);
    if (!pairQuoteSelection.ok) {
      rec(\`blocked: \${pairQuoteSelection.reason}\`);
      return blocked(
        \`\${pair} fresh price check failed: \${pairQuoteSelection.reason}.\`,
        { pairQuoteSelection },
      );
    }
    freshQuote = pairQuoteSelection.quote;
`;
  if (!out.includes(newQuoteSelection)) {
    out = replaceRequired(out, oldQuoteSelection, newQuoteSelection, 'pair-specific fresh quote selection');
  }

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

  const previousConfirmation = `  const executablePrice = direction === 'long' ? protectiveCheck.ask : protectiveCheck.bid;
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

  // The scanner already established valid structure and at least the configured
  // R:R. Reprice the pair at the actual ask/bid and move TP only as far as needed
  // to preserve that floor, subject to a small pair-priced extension cap.
  const executionTargetRebase = maybeRebaseIctTarget({
    pair,
    direction,
    executablePrice,
    stopLoss,
    currentTarget: targetProfit,
    scannerRR: Number(analysis.rr ?? analysis.targetConfidence?.actualRR ?? 0),
    executableRR: finalTargetConfidence.actualRR,
    minimumRR: Number(config.minRR ?? analysis.minimumRR ?? 1.5),
    maxExtensionPips: Number(process.env.ICT_EXECUTION_TARGET_REBASE_MAX_PIPS || 5),
  });
  if (executionTargetRebase.adjusted) {
    targetProfit = executionTargetRebase.targetProfit;
    finalAnalysis = {
      ...analysis,
      target1: targetProfit,
      takeProfit: targetProfit,
      targetAdjustedToMinRR: true,
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
      \`\${pair} fresh quote reduced R:R to \${executionTargetRebase.executableRR.toFixed(2)}; \` +
      \`TP rebased \${executionTargetRebase.extensionPips.toFixed(2)}p to preserve \` +
      \`\${executionTargetRebase.minimumRR.toFixed(2)}R.\`,
    );
  }

  if (!finalTargetConfidence.eligible || finalTargetConfidence.confidence < config.minConfidence) {
    const rrBelowFloor = finalTargetConfidence.actualRR < finalTargetConfidence.minimumRR;
    const accurateBlockers = (finalTargetConfidence.blockers || []).filter((blocker) =>
      !(rrBelowFloor && String(blocker).startsWith('target-hit confidence')),
    );
    if (rrBelowFloor && executionTargetRebase.blocker) accurateBlockers.push(executionTargetRebase.blocker);
    return blocked(
      \`Final executable-price confirmation rejected for \${pair}: \${accurateBlockers.join('; ') || 'confidence gate failed'}.\`,
      { finalTargetConfidence, executionTargetRebase, pair },
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

  // Position size, margin, and actual risk must use the same executable entry and
  // final TP that are sent to OANDA; the earlier planned-entry sizing is stale.
  slPips = +(Math.abs(entry - stopLoss) / pipSize).toFixed(1);
  tpPips = +(Math.abs(targetProfit - entry) / pipSize).toFixed(1);
  sizing = computeFixedDollarSizing({
    pair, direction, entryPrice: entry, targetRiskUSD,
    stopLossPips: slPips, stopLossPrice: stopLoss,
    takeProfitPips: tpPips, takeProfitPrice: targetProfit,
    accountMarginRate: parseFloat(account?.marginRate ?? 0),
    accountBalanceUSD: balanceUSD,
  });
  units = sizing.signedUnits;
  if (!units || Math.abs(units) < 1) {
    return blocked(\`\${pair} final executable sizing produced 0 units; riskUSD=\${targetRiskUSD}, stopPips=\${slPips}.\`);
  }
  const finalMarginCheck = checkMargin({
    marginAvailable,
    estimatedMargin: sizing.estimatedMarginRequired,
  });
  if (!finalMarginCheck.allowed) {
    return blocked(\`\${pair}: \${finalMarginCheck.reason}\`);
  }
  const finalRiskCheck = checkRiskPerTrade({
    balanceUSD,
    actualDollarRisk: sizing.actualRiskUSD,
    stopLossPips: slPips,
    positionSize: Math.abs(units),
  });
  if (!finalRiskCheck.passed) {
    return blocked(\`\${pair}: \${finalRiskCheck.reason}\`);
  }
  if (autoAi) {
    const finalOpenRiskPercent = computeOpenRiskPercent(openTradesForBudget, balanceUSD) ?? 0;
    const finalTradeRiskPercent = +((sizing.actualRiskUSD / balanceUSD) * 100).toFixed(4);
    const finalTotalCheck = checkTotalOpenRisk(finalOpenRiskPercent, finalTradeRiskPercent);
    if (!finalTotalCheck.allowed) return blocked(\`\${pair}: \${finalTotalCheck.reason}\`);
  }
`;

  if (out.includes(newConfirmation)) {
    out = out.split(oldConfirmation).join('').split(previousConfirmation).join('');
    const firstEnhanced = out.indexOf(newConfirmation);
    if (firstEnhanced >= 0) {
      const head = out.slice(0, firstEnhanced + newConfirmation.length);
      const tail = out.slice(firstEnhanced + newConfirmation.length).split(newConfirmation).join('');
      out = head + tail;
    }
  } else if (out.includes(previousConfirmation)) {
    out = out.replace(previousConfirmation, newConfirmation);
  } else {
    out = replaceRequired(
      out,
      oldConfirmation,
      newConfirmation,
      'final executable-price confirmation block',
    );
  }

  const executablePriceDeclarations = out.match(
    /const executablePrice = direction === 'long' \? protectiveCheck\.ask : protectiveCheck\.bid;/g,
  ) || [];
  if (executablePriceDeclarations.length !== 1) {
    throw new Error(
      `[ICT_RUNTIME_GATE_FIX] expected exactly one executable-price confirmation, found ${executablePriceDeclarations.length}`,
    );
  }

  const required = [
    "selectIctPairQuote(pricingPayload, pair)",
    "Final executable-price confirmation rejected for ${pair}",
    "ICT_EXECUTION_TARGET_REBASE_MAX_PIPS || 5",
    'sizing = computeFixedDollarSizing({',
    'units = sizing.signedUnits;',
  ];
  const missing = required.filter((marker) => !out.includes(marker));
  if (missing.length) {
    throw new Error(`[ICT_RUNTIME_GATE_FIX] ICT execution accuracy markers missing: ${missing.join(', ')}`);
  }
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
