import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function patch(relativePath, transform, markers) {
  const path = resolve(ROOT, relativePath);
  const before = readFileSync(path, 'utf8');
  const after = transform(before);
  const missing = markers.filter((marker) => !after.includes(marker));
  if (missing.length) {
    throw new Error(`${relativePath} manual-risk patch incomplete: ${missing.join(', ')}`);
  }
  if (after !== before) writeFileSync(path, after, 'utf8');
  console.log(`[MANUAL_TARGET_RISK] verified ${relativePath}${after !== before ? ' (patched)' : ''}`);
}

function replaceRequired(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  if (!source.includes(oldText)) throw new Error(`Missing manual-risk source marker: ${label}`);
  return source.replace(oldText, newText);
}

export function applyManualTargetRiskRuntime() {
  patch(
    'server/index.js',
    (source) => {
      let out = source;
      const importLine = "import { deriveQualifiedManualRisk } from './manualExecutionRisk.js';";
      if (!out.includes(importLine)) {
        out = replaceRequired(
          out,
          "import { getRiskStatus } from './riskManager.js';",
          "import { getRiskStatus } from './riskManager.js';\n" + importLine,
          'manual risk import',
        );
      }

      const oldIct = `  try {
    const { pair, direction, units, entry, stopLoss, targetProfit, ictSignalId } = req.body || {};
    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => executeIctTrade({ pair, direction, units, entry, stopLoss, targetProfit, ictSignalId }, { client }),
    );`;
      const newIct = `  try {
    const { pair, direction, units, entry, stopLoss, targetProfit, ictSignalId } = req.body || {};
    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      async () => {
        const manualRisk = await deriveQualifiedManualRisk({ client });
        req.body.targetRiskUSD = manualRisk.targetRiskUSD;
        return executeIctTrade({
          pair, direction, units, entry, stopLoss, targetProfit, ictSignalId,
          targetRiskUSD: manualRisk.targetRiskUSD,
          manualExecution: true,
        }, { client });
      },
    );`;
      out = replaceRequired(out, oldIct, newIct, 'ICT manual risk derivation');

      const oldAuto = `    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => runAutoForUser({ client, engine, runId: req.body?.runId, scanMode, pairs }),
    );`;
      const newAuto = `    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      async () => {
        const manualExecution = engine === 'ppr' &&
          String(req.body?.executionSource || '') === 'qualified_signal_button_ppr';
        const manualRisk = manualExecution
          ? await deriveQualifiedManualRisk({ client })
          : null;
        if (manualRisk) req.body.targetRiskUSD = manualRisk.targetRiskUSD;
        return runAutoForUser({
          client,
          engine,
          runId: req.body?.runId,
          scanMode,
          pairs,
          targetRiskUSD: manualRisk?.targetRiskUSD ?? null,
          manualExecution,
        });
      },
    );`;
      out = replaceRequired(out, oldAuto, newAuto, 'PPR manual risk derivation');
      return out;
    },
    [
      "deriveQualifiedManualRisk",
      'targetRiskUSD: manualRisk.targetRiskUSD',
      "executionSource || '') === 'qualified_signal_button_ppr'",
      'targetRiskUSD: manualRisk?.targetRiskUSD ?? null',
    ],
  );

  patch(
    'server/ictExecution.js',
    (source) => {
      let out = source;
      const oldRisk = `  const effectiveRiskPercent = capPerTradeRiskPercent(config.maxRiskPercent);
  const requestedRiskUSD = +(balanceUSD * (effectiveRiskPercent / 100)).toFixed(2);`;
      const newRisk = `  const effectiveRiskPercent = capPerTradeRiskPercent(config.maxRiskPercent);
  const expectedTargetRiskUSD = +(balanceUSD * (effectiveRiskPercent / 100)).toFixed(2);
  const suppliedTargetRiskUSD = Number(params.targetRiskUSD);
  if (params.manualExecution === true && (!Number.isFinite(suppliedTargetRiskUSD) || suppliedTargetRiskUSD <= 0)) {
    return blocked('ICT manual execution failed: targetRiskUSD must be included by the trusted server route.');
  }
  if (
    params.manualExecution === true &&
    Math.abs(suppliedTargetRiskUSD - expectedTargetRiskUSD) > 0.01
  ) {
    return blocked(
      \`ICT manual execution risk mismatch: supplied=$\${suppliedTargetRiskUSD.toFixed(2)} \` +
      \`expected=$\${expectedTargetRiskUSD.toFixed(2)} (\${effectiveRiskPercent}% of balance).\`,
    );
  }
  const requestedRiskUSD = expectedTargetRiskUSD;`;
      out = replaceRequired(out, oldRisk, newRisk, 'ICT targetRiskUSD validation');

      const oldBudget = `  if (!dailyBudget.allowed) return blocked(dailyBudget.reason);
  const targetRiskUSD = dailyBudget.approvedRiskUSD;`;
      const newBudget = `  if (!dailyBudget.allowed) return blocked(dailyBudget.reason);
  if (params.manualExecution === true && dailyBudget.capped) {
    return blocked(
      \`Full \${effectiveRiskPercent}% manual risk is unavailable within the remaining daily-loss budget; \` +
      \`requested=$\${requestedRiskUSD.toFixed(2)} approved=$\${dailyBudget.approvedRiskUSD.toFixed(2)}.\`,
    );
  }
  const targetRiskUSD = params.manualExecution === true
    ? requestedRiskUSD
    : dailyBudget.approvedRiskUSD;`;
      out = replaceRequired(out, oldBudget, newBudget, 'ICT exact manual risk budget');
      return out;
    },
    [
      'expectedTargetRiskUSD',
      'ICT manual execution failed: targetRiskUSD must be included by the trusted server route.',
      'params.manualExecution === true && dailyBudget.capped',
    ],
  );

  patch(
    'server/oandaTrade.js',
    (source) => {
      let out = source;
      out = replaceRequired(
        out,
        '  const { client, autoAi = false } = options;',
        '  const { client, autoAi = false, targetRiskUSD = null, manualExecution = false } = options;',
        'shared executor manual risk options',
      );

      const oldDynamic = `  if (!dynamicRisk.allowed) {
    return blocked(
      \`Dynamic risk sizing rejected (\${dynamicRisk.reason}). \` +
      \`balance=$\${balanceUSD.toFixed(2)} confidence=\${signal.confidence}%\`
    );
  }

  // Hard per-trade risk cap`;
      const newDynamic = `  if (!dynamicRisk.allowed) {
    return blocked(
      \`Dynamic risk sizing rejected (\${dynamicRisk.reason}). \` +
      \`balance=$\${balanceUSD.toFixed(2)} confidence=\${signal.confidence}%\`
    );
  }

  if (manualExecution === true) {
    const expectedManualRiskUSD = +(balanceUSD * 0.0125).toFixed(2);
    const suppliedManualRiskUSD = Number(targetRiskUSD ?? signal.targetRiskUSD);
    if (!Number.isFinite(suppliedManualRiskUSD) || suppliedManualRiskUSD <= 0) {
      return blocked('PPR manual execution failed: targetRiskUSD must be included by the trusted server route.');
    }
    if (Math.abs(suppliedManualRiskUSD - expectedManualRiskUSD) > 0.01) {
      return blocked(
        \`PPR manual execution risk mismatch: supplied=$\${suppliedManualRiskUSD.toFixed(2)} \` +
        \`expected=$\${expectedManualRiskUSD.toFixed(2)} (1.25% of balance).\`,
      );
    }
    dynamicRisk.riskPercent = 1.25;
    dynamicRisk.riskUSD = expectedManualRiskUSD;
    signal.targetRiskUSD = expectedManualRiskUSD;
    signal.riskPercent = 1.25;
  }

  // Hard per-trade risk cap`;
      out = replaceRequired(out, oldDynamic, newDynamic, 'PPR exact manual risk override');

      const oldBudget = `  if (dailyBudget.capped) {
    dynamicRisk.riskUSD = dailyBudget.approvedRiskUSD;
    dynamicRisk.riskPercent = +((dailyBudget.approvedRiskUSD / balanceUSD) * 100).toFixed(4);
  }`;
      const newBudget = `  if (dailyBudget.capped) {
    if (manualExecution === true) {
      return blocked(
        \`Full 1.25% manual risk is unavailable within the remaining daily-loss budget; \` +
        \`requested=$\${dynamicRisk.riskUSD.toFixed(2)} approved=$\${dailyBudget.approvedRiskUSD.toFixed(2)}.\`,
      );
    }
    dynamicRisk.riskUSD = dailyBudget.approvedRiskUSD;
    dynamicRisk.riskPercent = +((dailyBudget.approvedRiskUSD / balanceUSD) * 100).toFixed(4);
  }`;
      out = replaceRequired(out, oldBudget, newBudget, 'PPR exact daily budget');
      return out;
    },
    [
      'manualExecution = false',
      'PPR manual execution failed: targetRiskUSD must be included by the trusted server route.',
      'dynamicRisk.riskPercent = 1.25',
      'Full 1.25% manual risk is unavailable',
    ],
  );

  for (const relativePath of ['server/autoAiRouter.js', 'server/pprAutoTrade.js', 'server/pprExecution.js']) {
    patch(
      relativePath,
      (source) => source,
      relativePath.endsWith('autoAiRouter.js')
        ? ['targetRiskUSD = null', 'manualExecution = false', 'targetRiskUSD,', 'manualExecution,']
        : relativePath.endsWith('pprAutoTrade.js')
          ? ['targetRiskUSD = null', 'manualExecution = false', 'targetRiskUSD,', 'manualExecution,']
          : ['targetRiskUSD = null', 'manualExecution = false', 'targetRiskUSD: authoritativeTargetRiskUSD'],
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  applyManualTargetRiskRuntime();
}
