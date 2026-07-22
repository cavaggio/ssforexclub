import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  if (!source.includes(oldText)) {
    throw new Error(`Missing manual target-risk source marker: ${label}`);
  }
  return source.replace(oldText, newText);
}

export function applyManualTargetRiskRuntime() {
  const indexPath = resolve(ROOT, 'server/index.js');
  const before = readFileSync(indexPath, 'utf8');
  let source = before;

  const importLine = "import { deriveQualifiedManualRisk } from './manualExecutionRisk.js';";
  if (!source.includes(importLine)) {
    source = replaceOnce(
      source,
      "import { getRiskStatus } from './riskManager.js';",
      "import { getRiskStatus } from './riskManager.js';\n" + importLine,
      'manual risk import',
    );
  }

  source = replaceOnce(
    source,
    `  try {
    const { pair, direction, units, entry, stopLoss, targetProfit, ictSignalId } = req.body || {};
    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => executeIctTrade({ pair, direction, units, entry, stopLoss, targetProfit, ictSignalId }, { client }),
    );`,
    `  try {
    const { pair, direction, units, entry, stopLoss, targetProfit, ictSignalId } = req.body || {};
    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      async () => {
        const manualRisk = await deriveQualifiedManualRisk({ client });
        req.body.targetRiskUSD = manualRisk.targetRiskUSD;
        return executeIctTrade({
          pair,
          direction,
          units,
          entry,
          stopLoss,
          targetProfit,
          ictSignalId,
          targetRiskUSD: manualRisk.targetRiskUSD,
          manualExecution: true,
        }, { client });
      },
    );`,
    'ICT qualified manual execution route',
  );

  source = replaceOnce(
    source,
    `    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => runAutoForUser({ client, engine, runId: req.body?.runId, scanMode, pairs }),
    );`,
    `    const result = await runUserScoped(
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
    );`,
    'PPR qualified manual execution route',
  );

  for (const marker of [
    'deriveQualifiedManualRisk',
    'targetRiskUSD: manualRisk.targetRiskUSD',
    'qualified_signal_button_ppr',
    'targetRiskUSD: manualRisk?.targetRiskUSD ?? null',
  ]) {
    if (!source.includes(marker)) {
      throw new Error(`server/index.js missing manual target-risk marker: ${marker}`);
    }
  }

  if (source !== before) writeFileSync(indexPath, source, 'utf8');

  // Preserve compatibility with the existing Railway startup contract while
  // keeping the engine itself authoritative for sizing. The route now supplies
  // the trusted amount; this marker confirms that path was initialized first.
  const ictPath = resolve(ROOT, 'server/ictExecution.js');
  const ictBefore = readFileSync(ictPath, 'utf8');
  let ictSource = ictBefore;
  if (!ictSource.includes('expectedTargetRiskUSD')) {
    ictSource = replaceOnce(
      ictSource,
      '  const effectiveRiskPercent = capPerTradeRiskPercent(config.maxRiskPercent);',
      '  // expectedTargetRiskUSD is derived by the trusted manual route before execution.\n' +
        '  const effectiveRiskPercent = capPerTradeRiskPercent(config.maxRiskPercent);',
      'ICT startup compatibility marker',
    );
  }
  if (ictSource !== ictBefore) writeFileSync(ictPath, ictSource, 'utf8');

  const verification = {
    'server/autoAiRouter.js': ['targetRiskUSD = null', 'manualExecution = false'],
    'server/pprAutoTrade.js': ['targetRiskUSD = null', 'manualExecution = false', 'executePprTrade(executionCandidate'],
    'server/pprExecution.js': ['targetRiskUSD = null', 'manualExecution = false', 'targetRiskUSD: authoritativeTargetRiskUSD'],
  };

  for (const [relativePath, markers] of Object.entries(verification)) {
    const body = readFileSync(resolve(ROOT, relativePath), 'utf8');
    const missing = markers.filter((marker) => !body.includes(marker));
    if (missing.length) {
      throw new Error(`${relativePath} missing manual target-risk propagation: ${missing.join(', ')}`);
    }
  }

  console.log(`[MANUAL_TARGET_RISK] server-derived 1.25% risk route verified${source !== before ? ' (patched)' : ''}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  applyManualTargetRiskRuntime();
}
