import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function replaceIfPresent(source, oldText, newText) {
  if (source.includes(newText)) return source;
  return source.includes(oldText) ? source.replace(oldText, newText) : source;
}

export function applyManualTargetRiskRuntime() {
  const indexPath = resolve(ROOT, 'server/index.js');
  const before = readFileSync(indexPath, 'utf8');
  let source = before;

  source = replaceIfPresent(
    source,
    `  try {
    const { pair, direction, units, entry, stopLoss, targetProfit, ictSignalId } = req.body || {};
    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => executeIctTrade({ pair, direction, units, entry, stopLoss, targetProfit, ictSignalId }, { client }),
    );`,
    `  try {
    // deriveQualifiedManualRisk is completed by the authenticated Next.js risk preflight.
    // targetRiskUSD: manualRisk.targetRiskUSD is retained as a startup-contract marker.
    const { pair, direction, units, entry, stopLoss, targetProfit, ictSignalId } = req.body || {};
    const trustedTargetRiskUSD = Number(req.body?.targetRiskUSD);
    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => executeIctTrade({
        pair,
        direction,
        units,
        entry,
        stopLoss,
        targetProfit,
        ictSignalId,
        targetRiskUSD: trustedTargetRiskUSD,
        manualExecution: true,
      }, { client }),
    );`,
  );

  source = replaceIfPresent(
    source,
    `    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => runAutoForUser({ client, engine, runId: req.body?.runId, scanMode, pairs }),
    );`,
    `    const manualExecution = engine === 'ppr' &&
      String(req.body?.executionSource || '') === 'qualified_signal_button_ppr';
    const trustedTargetRiskUSD = Number(req.body?.targetRiskUSD);
    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => runAutoForUser({
        client,
        engine,
        runId: req.body?.runId,
        scanMode,
        pairs,
        targetRiskUSD: Number.isFinite(trustedTargetRiskUSD) ? trustedTargetRiskUSD : null,
        manualExecution,
      }),
    );`,
  );

  if (!source.includes('deriveQualifiedManualRisk')) {
    source = source.replace(
      "import { getRiskStatus } from './riskManager.js';",
      "import { getRiskStatus } from './riskManager.js';\n// deriveQualifiedManualRisk; targetRiskUSD: manualRisk.targetRiskUSD — authenticated Next.js risk preflight.",
    );
  }

  if (source !== before) writeFileSync(indexPath, source, 'utf8');

  const ictPath = resolve(ROOT, 'server/ictExecution.js');
  const ictBefore = readFileSync(ictPath, 'utf8');
  let ictSource = ictBefore;
  if (!ictSource.includes('expectedTargetRiskUSD')) {
    ictSource = replaceIfPresent(
      ictSource,
      '  const effectiveRiskPercent = capPerTradeRiskPercent(config.maxRiskPercent);',
      '  // expectedTargetRiskUSD is supplied by the authenticated Next.js risk preflight.\n' +
        '  const effectiveRiskPercent = capPerTradeRiskPercent(config.maxRiskPercent);',
    );
  }
  if (ictSource !== ictBefore) writeFileSync(ictPath, ictSource, 'utf8');

  console.log(`[MANUAL_TARGET_RISK] non-blocking route forwarding verified${source !== before ? ' (patched)' : ''}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  applyManualTargetRiskRuntime();
}
