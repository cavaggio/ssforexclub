import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXECUTION = path.join(ROOT, 'server', 'ictExecution.js');
const TRADE_CONTEXT = path.join(ROOT, 'server', 'ictTradeContext.js');

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  const index = source.indexOf(before);
  if (index < 0) throw new Error(`[ICT_A_GRADE_PATCH] missing anchor: ${label}`);
  return source.slice(0, index) + after + source.slice(index + before.length);
}

let execution = fs.readFileSync(EXECUTION, 'utf8');
if (!execution.includes("from './ictAGradePrecision.js'")) {
  execution = replaceOnce(
    execution,
    "import { buildIctTradeEntryContext } from './ictTradeContext.js';\n",
    "import { buildIctTradeEntryContext } from './ictTradeContext.js';\nimport { evaluateIctAGradeSetup, ictAGradeConfig, recordIctAGradeDecision } from './ictAGradePrecision.js';\n",
    'A-grade import',
  );
}

execution = replaceOnce(
  execution,
  `  let analysis = authoritativeMatches ? authoritativeAnalysis : null;\n  let recomputeError = null;\n  let usedQualifiedSnapshotGrace = false;\n\n  // Generated-source compatibility marker retained for the daily policy check:\n  // analysis = authoritativeAnalysis || await applyCombinedLearningCalibration\n  if (authoritativeMatches) {\n    rec(\`using scanner-authoritative qualified snapshot for \${pair} \${wantSignal}\`);\n  } else {\n    try {`,
  `  // ICT_A_GRADE_FRESH_THESIS_V1: autonomous execution must independently\n  // recompute the full thesis at order time. The scanner snapshot is evidence of\n  // qualification, never permission to skip fresh D1/H4/H1/M5 authorization.\n  const freshThesisRequired = autoAi === true;\n  let analysis = authoritativeMatches && !freshThesisRequired ? authoritativeAnalysis : null;\n  let recomputeError = null;\n  let usedQualifiedSnapshotGrace = false;\n\n  // Generated-source compatibility marker retained for the daily policy check:\n  // analysis = authoritativeAnalysis || await applyCombinedLearningCalibration\n  if (authoritativeMatches && !freshThesisRequired) {\n    rec(\`using scanner-authoritative qualified snapshot for \${pair} \${wantSignal}\`);\n  } else {\n    if (authoritativeMatches && freshThesisRequired) {\n      rec(\`A-grade fresh-thesis revalidation started for \${pair} \${wantSignal}\`);\n    }\n    try {`,
  'force autonomous fresh thesis',
);

execution = replaceOnce(
  execution,
  `  if (!(analysis.confidence >= config.minConfidence)) {\n    return blocked(\`ICT confidence below auto-trade threshold (\${analysis.confidence} < \${config.minConfidence}).\`);\n  }\n  const entryAuthorization = analysis?.entryAuthorization || {};`,
  `  if (!(analysis.confidence >= config.minConfidence)) {\n    return blocked(\`ICT confidence below auto-trade threshold (\${analysis.confidence} < \${config.minConfidence}).\`);\n  }\n  if (freshThesisRequired && authoritativeMatches) {\n    const scannerCycleId = String(authoritativeAnalysis?.entryAuthorization?.cycleId || '');\n    const freshCycleId = String(analysis?.entryAuthorization?.cycleId || '');\n    const scannerFamily = String(authoritativeAnalysis?.correctiveGate?.family || '');\n    const freshFamily = String(analysis?.correctiveGate?.family || '');\n    if (scannerCycleId && freshCycleId && scannerCycleId !== freshCycleId) {\n      return blocked(\`ICT fresh-thesis revalidation changed the authorized cycle (\${scannerCycleId} -> \${freshCycleId}); wait for the new setup to qualify independently.\`);\n    }\n    if (scannerFamily && freshFamily && scannerFamily !== freshFamily) {\n      return blocked(\`ICT fresh-thesis revalidation changed entry family (\${scannerFamily} -> \${freshFamily}).\`);\n    }\n  }\n  const entryAuthorization = analysis?.entryAuthorization || {};`,
  'fresh cycle continuity',
);

execution = replaceOnce(
  execution,
  `  if (autoAi) {\n    const confCheck = checkAutoExecutionConfidence(analysis.confidence, {\n      ...riskConfig(),\n      autoExecutionMinConfidence: config.minConfidence,\n    });\n    if (!confCheck.passed) return blocked(confCheck.reason);\n  }\n\n  const universalPolicy = {`,
  `  if (autoAi) {\n    const confCheck = checkAutoExecutionConfidence(analysis.confidence, {\n      ...riskConfig(),\n      autoExecutionMinConfidence: config.minConfidence,\n    });\n    if (!confCheck.passed) return blocked(confCheck.reason);\n  }\n\n  const aGradeConfig = ictAGradeConfig();\n  const preExecutionAGrade = evaluateIctAGradeSetup(analysis, {\n    stage: 'pre_execution',\n    config: aGradeConfig,\n  });\n  analysis = { ...analysis, aGrade: preExecutionAGrade };\n  await recordIctAGradeDecision({\n    client, analysis, evaluation: preExecutionAGrade, stage: 'pre_execution', now,\n  });\n  if (autoAi && aGradeConfig.required && !preExecutionAGrade.passed) {\n    return blocked(\n      \`ICT A-grade pre-execution gate rejected \${pair}: \${preExecutionAGrade.blockers.join('; ')}.\`,\n      { aGrade: preExecutionAGrade },\n    );\n  }\n\n  const universalPolicy = {`,
  'pre-execution A-grade gate',
);

execution = replaceOnce(
  execution,
  `  // ── 6. Credentials / per-user client ───────────────────────────────────────\n  if (!client) return blocked('Missing per-user OANDA client — credentials not ready.');\n\n  // ── 7. Duplicate protection (shared lock with V3) ──────────────────────────\n  const reconcileFn = reconcile || (() => reconcileTradeLock(pair, direction, { client }));`,
  `  // ── 6. Credentials / per-user client ───────────────────────────────────────\n  if (!client) return blocked('Missing per-user OANDA client — credentials not ready.');\n\n  // FTMO execution uses OANDA for market data only. Pull authoritative account\n  // state directly from MT5 immediately before any order is allowed.\n  const ftmoNativeRisk = client?.executionProvider === 'ftmo_mt5_ea';\n  let executionRiskState = null;\n  if (ftmoNativeRisk) {\n    try {\n      if (typeof client.getExecutionRiskState !== 'function') {\n        return blocked('FTMO MT5 execution risk telemetry is unavailable; no OANDA account-state fallback is permitted.');\n      }\n      executionRiskState = await client.getExecutionRiskState();\n    } catch (err) {\n      return blocked(\`FTMO MT5 pre-trade telemetry failed: \${err.message}.\`);\n    }\n    const minimumFreeMarginPercent = Math.max(1, Number(process.env.FTMO_MIN_FREE_MARGIN_PERCENT || 25));\n    const maximumOpenPositions = Math.max(1, Number(process.env.FTMO_MAX_OPEN_SIGNAL_STACK_POSITIONS || 2));\n    if (executionRiskState?.tradingLocked === true) {\n      return blocked('FTMO MT5 daily risk lock is active.', { executionRiskState });\n    }\n    if (Number(executionRiskState?.dailyLossPercent) >= 2) {\n      return blocked(\`FTMO MT5 daily loss is \${Number(executionRiskState.dailyLossPercent).toFixed(2)}%; 2% daily lock reached.\`, { executionRiskState });\n    }\n    if (!Number.isFinite(Number(executionRiskState?.freeMarginPercent)) || Number(executionRiskState.freeMarginPercent) < minimumFreeMarginPercent) {\n      return blocked(\`FTMO MT5 free margin is \${executionRiskState?.freeMarginPercent ?? 'unknown'}%; minimum is \${minimumFreeMarginPercent}%.\`, { executionRiskState });\n    }\n    const normalizedSymbol = String(pair || '').replace(/[_/]/g, '').toUpperCase();\n    const wantedSide = direction === 'long' ? 'long' : 'short';\n    const nativeDuplicate = (executionRiskState?.positions || []).some((position) =>\n      String(position?.symbol || '').replace(/[_/]/g, '').toUpperCase().startsWith(normalizedSymbol) &&\n      String(position?.side || '').toLowerCase() === wantedSide\n    );\n    if (nativeDuplicate) {\n      return blocked(\`FTMO MT5 already has an active Signal Stack \${pair} \${direction} position.\`, { executionRiskState });\n    }\n    if (Number(executionRiskState?.positionCount || 0) >= maximumOpenPositions) {\n      return blocked(\`FTMO MT5 already has \${executionRiskState.positionCount} managed positions; maximum concurrent positions is \${maximumOpenPositions}.\`, { executionRiskState });\n    }\n    analysis = {\n      ...analysis,\n      executionRiskContext: {\n        source: 'ftmo_mt5_ea',\n        balance: executionRiskState.balance,\n        equity: executionRiskState.equity,\n        marginFree: executionRiskState.marginFree,\n        freeMarginPercent: executionRiskState.freeMarginPercent,\n        dailyLossPercent: executionRiskState.dailyLossPercent,\n        effectiveRiskPercent: executionRiskState.effectiveRiskPercent,\n        tradingLocked: executionRiskState.tradingLocked,\n        positionCount: executionRiskState.positionCount,\n      },\n    };\n    rec(\`FTMO-native risk telemetry accepted balance=\${executionRiskState.balance} equity=\${executionRiskState.equity} freeMargin=\${executionRiskState.freeMarginPercent}% dailyLoss=\${executionRiskState.dailyLossPercent}% positions=\${executionRiskState.positionCount}\`);\n  }\n\n  // ── 7. Duplicate protection (shared lock with V3) ──────────────────────────\n  const reconcileFn = reconcile || (ftmoNativeRisk\n    ? async () => false\n    : () => reconcileTradeLock(pair, direction, { client }));`,
  'FTMO-native pretrade telemetry',
);

execution = replaceOnce(
  execution,
  `  const accountFn = getAccount || (() => getAccountSummary({ client }));`,
  `  const accountFn = getAccount || (ftmoNativeRisk\n    ? async () => ({\n        balance: String(executionRiskState.balance),\n        marginAvailable: String(executionRiskState.marginFree),\n        marginRate: '0',\n      })\n    : () => getAccountSummary({ client }));`,
  'FTMO-native account summary',
);

execution = replaceOnce(
  execution,
  `  const riskAccountId =\n    client?.accountId || client?.accountID || client?.account_id ||\n    client?.config?.accountId || client?.defaults?.accountId;`,
  `  const riskAccountId =\n    client?.executionAccountId ||\n    client?.accountId || client?.accountID || client?.account_id ||\n    client?.config?.accountId || client?.defaults?.accountId;`,
  'execution account risk identity',
);

execution = replaceOnce(
  execution,
  `  try { const openFn = getOpen || (() => getOpenTrades({ client })); openTradesForBudget = (await openFn()) || []; } catch (err) { return blocked(\`Could not calculate open stop risk: \${err.message}\`); }`,
  `  try {\n    const openFn = getOpen || (ftmoNativeRisk ? async () => [] : () => getOpenTrades({ client }));\n    openTradesForBudget = (await openFn()) || [];\n  } catch (err) { return blocked(\`Could not calculate open stop risk: \${err.message}\`); }`,
  'FTMO-native open position authority',
);

execution = replaceOnce(
  execution,
  `  analysis = {\n    ...finalAnalysis,\n    entry,\n    target1: targetProfit,\n    takeProfit: targetProfit,\n    rr: finalTargetConfidence.actualRR,\n    confidence: finalTargetConfidence.confidence,\n    targetHitConfidence: finalTargetConfidence.confidence,\n    targetConfidence: finalTargetConfidence,\n    executionTargetRebase,\n  };\n\n  // Position size, margin, and actual risk must use the same executable entry and`,
  `  analysis = {\n    ...finalAnalysis,\n    entry,\n    target1: targetProfit,\n    takeProfit: targetProfit,\n    rr: finalTargetConfidence.actualRR,\n    confidence: finalTargetConfidence.confidence,\n    targetHitConfidence: finalTargetConfidence.confidence,\n    targetConfidence: finalTargetConfidence,\n    executionTargetRebase,\n    executionRiskContext: analysis.executionRiskContext || null,\n  };\n\n  const finalAGrade = evaluateIctAGradeSetup(analysis, {\n    targetConfidence: finalTargetConfidence,\n    stage: 'final_price',\n    config: aGradeConfig,\n  });\n  analysis = { ...analysis, aGrade: finalAGrade };\n  if (typeof client?.setFinalAGrade === 'function') client.setFinalAGrade(finalAGrade);\n  await recordIctAGradeDecision({\n    client, analysis, evaluation: finalAGrade, stage: 'final_price', executionTelemetry: executionRiskState, now,\n  });\n  if (autoAi && aGradeConfig.required && !finalAGrade.passed) {\n    return blocked(\n      \`ICT A-grade final-price gate rejected \${pair}: \${finalAGrade.blockers.join('; ')}.\`,\n      { aGrade: finalAGrade, finalTargetConfidence },\n    );\n  }\n\n  // Position size, margin, and actual risk must use the same executable entry and`,
  'final-price A-grade gate',
);

execution = replaceOnce(
  execution,
  `  const fill = resp?.orderFillTransaction;\n  if (!fill) {`,
  `  const fill = resp?.orderFillTransaction;\n  const mt5Execution = resp?.mt5Execution || null;\n  if (!fill) {`,
  'preserve MT5 fill metadata',
);

execution = replaceOnce(
  execution,
  `  const fillPrice = parseFloat(fill.price ?? entry);\n  // Projected hold-time`,
  `  const fillPrice = parseFloat(fill.price ?? entry);\n  if (ftmoNativeRisk && Number.isFinite(Number(mt5Execution?.notionalUnits)) && Number(mt5Execution.notionalUnits) > 0) {\n    units = direction === 'short' ? -Math.abs(Number(mt5Execution.notionalUnits)) : Math.abs(Number(mt5Execution.notionalUnits));\n  }\n  // Projected hold-time`,
  'MT5 canonical notional sizing',
);

execution = replaceOnce(
  execution,
  `  const entryContext = buildIctTradeEntryContext({ analysis, brokerTradeId: tradeId, filledAt: now });\n  rec(\`filled tradeId=\${tradeId} price=\${fillPrice} units=\${units} holdMinutes=\${holdMinutes}\`);`,
  `  const entryContext = buildIctTradeEntryContext({ analysis, brokerTradeId: tradeId, filledAt: now });\n  await recordIctAGradeDecision({\n    client, analysis, evaluation: analysis.aGrade, stage: 'executed', executionTelemetry: executionRiskState,\n    executed: true, brokerTradeId: tradeId, now,\n  });\n  rec(\`filled tradeId=\${tradeId} price=\${fillPrice} units=\${units} holdMinutes=\${holdMinutes} aGrade=\${analysis?.aGrade?.score ?? 'n/a'}\`);`,
  'executed A-grade audit',
);

execution = replaceOnce(
  execution,
  `    entryAuthorization,\n    riskModel: analysis.riskModel,`,
  `    entryAuthorization,\n    aGrade: analysis.aGrade ?? null,\n    executionRiskContext: analysis.executionRiskContext ?? null,\n    mt5Execution,\n    riskModel: analysis.riskModel,`,
  'return A-grade and FTMO execution context',
);

fs.writeFileSync(EXECUTION, execution);

let context = fs.readFileSync(TRADE_CONTEXT, 'utf8');
context = replaceOnce(
  context,
  `    correctiveGate: analysis.correctiveGate || null,\n    learningAdjustment: {`,
  `    correctiveGate: analysis.correctiveGate || null,\n    aGrade: analysis.aGrade || null,\n    executionRisk: analysis.executionRiskContext || null,\n    learningAdjustment: {`,
  'trade context A-grade telemetry',
);
fs.writeFileSync(TRADE_CONTEXT, context);

const required = [
  'ICT_A_GRADE_FRESH_THESIS_V1',
  "stage: 'pre_execution'",
  "stage: 'final_price'",
  "source: 'ftmo_mt5_ea'",
  'getExecutionRiskState',
  'executionAccountId ||',
  'aGrade: analysis.aGrade ?? null',
];
for (const marker of required) {
  if (!execution.includes(marker)) throw new Error(`[ICT_A_GRADE_PATCH] verification failed: ${marker}`);
}
console.log('[ICT_A_GRADE_PATCH] fresh thesis, A-grade gate, and FTMO-native risk authority applied.');
