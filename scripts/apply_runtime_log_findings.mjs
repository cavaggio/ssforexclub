import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function replaceRequired(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`[RUNTIME_LOG_FINDINGS] missing ${label}`);
  return source.replace(before, after);
}

function replaceRouteSegment(source, startMarker, endMarker, patcher, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error(`[RUNTIME_LOG_FINDINGS] could not locate ${label}`);
  }
  const before = source.slice(start, end);
  const after = patcher(before);
  return source.slice(0, start) + after + source.slice(end);
}

export function patchRuntimeStartExactConfidence(source) {
  const exact =
    "  process.env.ICT_EXECUTION_MIN_CONFIDENCE = String(Math.max(80, Math.min(80, finiteNumber(process.env.ICT_EXECUTION_MIN_CONFIDENCE, 80))));\n" +
    "  process.env.ICT_MIN_CONFIDENCE = process.env.ICT_EXECUTION_MIN_CONFIDENCE;";
  if (source.includes(exact)) return source;

  const patterns = [
    /  process\.env\.ICT_EXECUTION_MIN_CONFIDENCE = String\(Math\.max\(80, finiteNumber\(process\.env\.ICT_EXECUTION_MIN_CONFIDENCE, 80\)\)\);/,
    /  process\.env\.ICT_MIN_CONFIDENCE = String\(Math\.max\(93, finiteNumber\(process\.env\.ICT_MIN_CONFIDENCE, 80\)\)\);/,
    /  process\.env\.ICT_MIN_CONFIDENCE = String\(Math\.max\(80, finiteNumber\(process\.env\.ICT_MIN_CONFIDENCE, 80\)\)\);/,
  ];
  let out = source;
  let changed = false;
  for (const pattern of patterns) {
    if (!pattern.test(out)) continue;
    out = out.replace(pattern, exact);
    changed = true;
    break;
  }
  if (!changed || !out.includes(exact)) {
    throw new Error('[RUNTIME_LOG_FINDINGS] runtime startup confidence contract not found');
  }
  return out;
}

export function patchExactIctConfidenceSource(source, kind) {
  let out = source;
  if (kind === 'engine') {
    out = out.replace(
      /minConfidence:\s*Math\.max\(80,\s*parseFloat\(process\.env\.ICT_EXECUTION_MIN_CONFIDENCE \|\| '80'\)\),/,
      'minConfidence: 80,',
    );
    if (!out.includes('minConfidence: 80,')) {
      throw new Error('[RUNTIME_LOG_FINDINGS] ICT engine exact 80% marker missing');
    }
    return out;
  }

  if (kind === 'autoTrade') {
    out = out.replace(
      /((?:export\s+)?function buildIctWatchState\(analyses = \[\], minConfidence = )\d+(, minRR = 1\.5\))?/,
      (_, prefix, minRrSuffix = '') => `${prefix}80${minRrSuffix}`,
    );
    out = out.replaceAll('confidence >= 93 && rr >= 1.5', 'confidence >= 80 && rr >= 1.5');
    out = out.replaceAll('confidence >= 85 && rr >= 1.5', 'confidence >= 80 && rr >= 1.5');
    if (!out.includes('minConfidence = 80')) {
      throw new Error('[RUNTIME_LOG_FINDINGS] ICT Auto AI exact 80% marker missing');
    }
    return out;
  }

  if (kind === 'execution') {
    out = out.replace(
      /minConfidence:\s*Math\.max\(80,\s*Number\(rawConfig\?\.minConfidence\) \|\| 80\),/,
      'minConfidence: 80,',
    );
    if (!out.includes('minConfidence: 80,')) {
      throw new Error('[RUNTIME_LOG_FINDINGS] ICT executor exact 80% marker missing');
    }
    return out;
  }

  throw new Error(`[RUNTIME_LOG_FINDINGS] unsupported confidence source kind: ${kind}`);
}

function patchIctManualRoute(segment) {
  if (segment.includes('targetRiskUSD: manualRisk.targetRiskUSD')) return segment;

  const generatedCallback = `      () => executeIctTrade(
        {
          pair, direction, units, entry, stopLoss, targetProfit, ictSignalId,
          signalConfidence, signalRR,
          manualExecution: manualExecution === true,
          executionSource,
        },
        { client },
      ),`;
  const generatedReplacement = `      async () => {
        const manualRisk = await deriveQualifiedManualRisk({ client });
        req.body.targetRiskUSD = manualRisk.targetRiskUSD;
        return executeIctTrade(
          {
            pair, direction, units, entry, stopLoss, targetProfit, ictSignalId,
            signalConfidence, signalRR,
            manualExecution: true,
            executionSource,
            targetRiskUSD: manualRisk.targetRiskUSD,
          },
          { client },
        );
      },`;

  if (segment.includes(generatedCallback)) {
    return segment.replace(generatedCallback, generatedReplacement);
  }

  const legacyBlock = `  try {
    const { pair, direction, units, entry, stopLoss, targetProfit, ictSignalId } = req.body || {};
    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => executeIctTrade({ pair, direction, units, entry, stopLoss, targetProfit, ictSignalId }, { client }),
    );`;
  const legacyReplacement = `  try {
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
    );`;

  if (segment.includes(legacyBlock)) {
    return segment.replace(legacyBlock, legacyReplacement);
  }

  throw new Error('[RUNTIME_LOG_FINDINGS] missing ICT qualified manual execution route');
}

function patchPprManualRoute(segment) {
  if (segment.includes('qualified_signal_button_ppr') && segment.includes('targetRiskUSD: manualRisk?.targetRiskUSD ?? null')) {
    return segment;
  }

  const before = `    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => runAutoForUser({ client, engine, runId: req.body?.runId, scanMode, pairs }),
    );`;
  const after = `    const result = await runUserScoped(
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

  if (!segment.includes(before)) {
    throw new Error('[RUNTIME_LOG_FINDINGS] missing PPR qualified manual execution route');
  }
  return segment.replace(before, after);
}

export function patchManualTargetRiskIndex(source) {
  let out = source;
  const importLine = "import { deriveQualifiedManualRisk } from './manualExecutionRisk.js';";
  if (!out.includes(importLine)) {
    out = replaceRequired(
      out,
      "import { getRiskStatus, resetDailyRisk } from './riskManager.js';",
      "import { getRiskStatus, resetDailyRisk } from './riskManager.js';\n" + importLine,
      'current risk-manager import',
    );
  }

  out = replaceRouteSegment(
    out,
    "app.post('/api/internal/oanda/ict/trade'",
    "// POST /api/internal/oanda/ict/auto",
    patchIctManualRoute,
    'ICT manual route segment',
  );

  out = replaceRouteSegment(
    out,
    "app.post('/api/internal/oanda/auto'",
    "// POST /api/internal/oanda/ict/reassess",
    patchPprManualRoute,
    'engine-routed Auto AI segment',
  );

  const required = [
    importLine,
    'targetRiskUSD: manualRisk.targetRiskUSD',
    'manualExecution: true',
    'qualified_signal_button_ppr',
    'targetRiskUSD: manualRisk?.targetRiskUSD ?? null',
  ];
  const missing = required.filter((marker) => !out.includes(marker));
  if (missing.length) {
    throw new Error(`[RUNTIME_LOG_FINDINGS] manual target-risk markers missing: ${missing.join(', ')}`);
  }
  return out;
}

function patchFile(root, relativePath, patcher) {
  const path = resolve(root, relativePath);
  if (!existsSync(path)) return false;
  const before = readFileSync(path, 'utf8');
  const after = patcher(before);
  if (after !== before) writeFileSync(path, after, 'utf8');
  console.log(`[RUNTIME_LOG_FINDINGS] verified ${relativePath}${after !== before ? ' (patched)' : ''}`);
  return after !== before;
}

export function applyRuntimeLogFindings(root = DEFAULT_ROOT) {
  // The approved ICT execution threshold is exactly 80%. A stale Railway value
  // of 85 previously overrode that policy and could suppress valid 80–84 signals.
  process.env.ICT_EXECUTION_MIN_CONFIDENCE = '80';
  process.env.ICT_MIN_CONFIDENCE = '80';

  const changed = [];
  if (patchFile(root, 'scripts/runtime_execution_start.mjs', patchRuntimeStartExactConfidence)) {
    changed.push('scripts/runtime_execution_start.mjs');
  }
  if (patchFile(root, 'server/ictEngine.js', (source) => patchExactIctConfidenceSource(source, 'engine'))) {
    changed.push('server/ictEngine.js');
  }
  if (patchFile(root, 'server/ictAutoTrade.js', (source) => patchExactIctConfidenceSource(source, 'autoTrade'))) {
    changed.push('server/ictAutoTrade.js');
  }
  if (patchFile(root, 'server/ictExecution.js', (source) => patchExactIctConfidenceSource(source, 'execution'))) {
    changed.push('server/ictExecution.js');
  }
  if (patchFile(root, 'server/index.js', patchManualTargetRiskIndex)) {
    changed.push('server/index.js');
  }

  console.log('[RUNTIME_LOG_FINDINGS] exact ICT confidence=80 and manual target-risk route verified');
  return changed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  applyRuntimeLogFindings();
}
