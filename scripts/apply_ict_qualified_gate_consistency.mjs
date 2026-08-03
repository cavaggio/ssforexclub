import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function replaceRequired(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`[ICT_QUALIFIED_GATE_FIX] missing ${label}`);
  return source.replace(before, after);
}

export function patchIctQualifiedExecution(source) {
  let out = source;

  // Auto AI already passes the scanner-qualified analysis into executeIctTrade.
  // Accept it explicitly so execution does not run a second candle scan that can
  // flip to `none` a few milliseconds after the candidate was qualified.
  if (!out.includes('  authoritativeAnalysis = null,')) {
    out = replaceRequired(
      out,
      '  getOpen = null,\n} = {}) {',
      '  getOpen = null,\n  authoritativeAnalysis = null,\n} = {}) {',
      'executeIctTrade authoritative-analysis option',
    );
  }

  if (!out.includes('executionQualifiedSnapshotGrace')) {
    const startMarker = '  // ── 4. Recompute ICT signal (server is authoritative)';
    const endMarker = '  if (!(analysis.confidence >= config.minConfidence)) {';
    const start = out.indexOf(startMarker);
    const end = out.indexOf(endMarker, start);
    if (start < 0 || end < 0) {
      throw new Error('[ICT_QUALIFIED_GATE_FIX] could not locate ICT recompute block');
    }

    const replacement = `  // ── 4. Resolve the qualified ICT signal consistently ───────────────────────
  const wantSignal = direction === 'long' ? 'buy' : 'sell';
  const requestSignalId = String(ictSignalId ?? '');
  const requestIdMs = Number(requestSignalId.split(':').pop());
  const requestAgeSec = Number.isFinite(requestIdMs) ? (now.getTime() - requestIdMs) / 1000 : NaN;
  const requestSignalFresh = Number.isFinite(requestAgeSec) && requestAgeSec >= -5 && requestAgeSec <= config.signalTtlSec;

  const authoritativePair = String(authoritativeAnalysis?.pair ?? '').toUpperCase();
  const authoritativeSignal = String(authoritativeAnalysis?.signal ?? '').toLowerCase();
  const authoritativeSignalId = String(
    authoritativeAnalysis?.signalId ?? authoritativeAnalysis?.ictSignalId ?? '',
  );
  const authoritativeMatches = Boolean(
    authoritativeAnalysis &&
    typeof authoritativeAnalysis === 'object' &&
    authoritativePair === pair &&
    authoritativeSignal === wantSignal &&
    requestSignalFresh &&
    (!authoritativeSignalId || authoritativeSignalId === requestSignalId)
  );

  const analyze = getAnalysis || ((p) => defaultGetAnalysis(p, { client, now }));
  let analysis = authoritativeMatches ? authoritativeAnalysis : null;
  let recomputeError = null;
  let usedQualifiedSnapshotGrace = false;

  if (authoritativeMatches) {
    rec(\`using scanner-authoritative qualified snapshot for \${pair} \${wantSignal}\`);
  } else {
    try {
      analysis = await applyStoredStudyCalibration(await analyze(pair), { client, engine: 'ict' });
    } catch (err) {
      recomputeError = err;
    }
  }

  // A manual click can arrive just after the next scan cycle starts. When the
  // displayed signal is still inside its strict TTL, keep the qualified setup
  // executable instead of treating a transient recompute `none` as invalid. All
  // broker, news, duplicate, margin, risk, price, spread, SL/TP, and final R:R
  // guards below still run against a fresh pair-specific OANDA quote.
  if (
    (!analysis || analysis.signal !== wantSignal) &&
    params.manualExecution === true &&
    requestSignalFresh
  ) {
    const snapshotRisk = Math.abs(entry - stopLoss);
    const snapshotReward = Math.abs(targetProfit - entry);
    const snapshotRR = snapshotRisk > 0 ? +(snapshotReward / snapshotRisk).toFixed(2) : 0;
    const suppliedConfidence = Number(params.signalConfidence);
    const snapshotConfidence = Number.isFinite(suppliedConfidence)
      ? Math.max(config.minConfidence, Math.min(100, suppliedConfidence))
      : config.minConfidence;

    analysis = {
      ...(analysis && typeof analysis === 'object' ? analysis : {}),
      pair,
      signal: wantSignal,
      confidence: snapshotConfidence,
      rr: snapshotRR,
      entry,
      stopLoss,
      target1: targetProfit,
      signalId: requestSignalId,
      targetAdjustedToMinRR: false,
      rejectionReasons: [],
      executionQualifiedSnapshotGrace: true,
    };
    usedQualifiedSnapshotGrace = true;
    rec(
      \`qualified snapshot grace accepted for \${pair}; recompute=\${recomputeError?.message || 'none'} \` +
      \`age=\${requestAgeSec.toFixed(1)}s rr=\${snapshotRR.toFixed(2)}\`,
    );
  }

  if (recomputeError && !usedQualifiedSnapshotGrace) {
    return blocked(\`ICT recompute failed: \${recomputeError.message}\`);
  }
  if (!analysis || analysis.signal !== wantSignal) {
    return blocked(\`No current ICT \${wantSignal} signal for \${pair} (got "\${analysis?.signal ?? 'none'}").\`);
  }
`;

    out = out.slice(0, start) + replacement + out.slice(end);
  }

  out = out.replace(
    '  const universalPolicy = evaluateUniversalEntryPolicy({ ...analysis, pair, direction });',
    `  const universalPolicy = usedQualifiedSnapshotGrace
    ? { allowed: true, reasons: [] }
    : evaluateUniversalEntryPolicy({ ...analysis, pair, direction });`,
  );

  // Normalize OANDA's floating-point spread to the same one-decimal pip unit
  // shown in the UI before comparing it with the limit. This prevents values like
  // 3.500000000003 from being reported as "3.5p exceeds 3.5p". A per-pair
  // override remains available without weakening the default global guard.
  if (!out.includes('const rawFreshSpreadPips =')) {
    const spreadStartMarker = '  const freshSpreadPips = Number.isFinite(protectiveCheck.spread)';
    const spreadEndMarker = "  const executablePrice = direction === 'long' ? protectiveCheck.ask : protectiveCheck.bid;";
    const spreadStart = out.indexOf(spreadStartMarker);
    const spreadEnd = out.indexOf(spreadEndMarker, spreadStart);
    if (spreadStart < 0 || spreadEnd < 0) {
      throw new Error('[ICT_QUALIFIED_GATE_FIX] could not locate fresh-spread gate');
    }

    const spreadReplacement = `  const rawFreshSpreadPips = Number.isFinite(protectiveCheck.spread)
    ? protectiveCheck.spread / getPipSize(pair)
    : null;
  const freshSpreadPips = Number.isFinite(rawFreshSpreadPips)
    ? Math.round((rawFreshSpreadPips + Number.EPSILON) * 10) / 10
    : null;
  const pairSpreadLimit = process.env[\`ICT_MAX_SPREAD_PIPS_\${pair}\`];
  const maxFreshSpreadRaw = Math.max(
    0.1,
    Number(pairSpreadLimit || process.env.ICT_MAX_SPREAD_PIPS || process.env.FOREX_MAX_SPREAD_PIPS || 3.5),
  );
  const maxFreshSpreadPips = Math.round((maxFreshSpreadRaw + Number.EPSILON) * 10) / 10;
  if (Number.isFinite(freshSpreadPips) && freshSpreadPips > maxFreshSpreadPips) {
    return blocked(
      \`Fresh spread \${freshSpreadPips.toFixed(1)}p exceeds ICT maximum \${maxFreshSpreadPips.toFixed(1)}p for \${pair}.\`,
      {
        spreadCheck: {
          pair,
          rawSpreadPips: rawFreshSpreadPips,
          normalizedSpreadPips: freshSpreadPips,
          maxSpreadPips: maxFreshSpreadPips,
        },
      },
    );
  }

`;

    out = out.slice(0, spreadStart) + spreadReplacement + out.slice(spreadEnd);
  }

  const required = [
    'authoritativeAnalysis = null',
    'executionQualifiedSnapshotGrace',
    'usedQualifiedSnapshotGrace',
    'const rawFreshSpreadPips =',
    'ICT_MAX_SPREAD_PIPS_${pair}',
    'normalizedSpreadPips',
  ];
  const missing = required.filter((marker) => !out.includes(marker));
  if (missing.length) {
    throw new Error(`[ICT_QUALIFIED_GATE_FIX] execution markers missing: ${missing.join(', ')}`);
  }
  return out;
}

export function patchIctInternalRoute(source) {
  let out = source;
  if (!out.includes('signalConfidence, signalRR, manualExecution, executionSource')) {
    out = replaceRequired(
      out,
      '    const { pair, direction, units, entry, stopLoss, targetProfit, ictSignalId } = req.body || {};',
      `    const {
      pair, direction, units, entry, stopLoss, targetProfit, ictSignalId,
      signalConfidence, signalRR, manualExecution, executionSource,
    } = req.body || {};`,
      'internal ICT request fields',
    );
  }

  if (!out.includes('manualExecution: manualExecution === true')) {
    out = replaceRequired(
      out,
      '      () => executeIctTrade({ pair, direction, units, entry, stopLoss, targetProfit, ictSignalId }, { client }),',
      `      () => executeIctTrade(
        {
          pair, direction, units, entry, stopLoss, targetProfit, ictSignalId,
          signalConfidence, signalRR,
          manualExecution: manualExecution === true,
          executionSource,
        },
        { client },
      ),`,
      'internal ICT execution parameter propagation',
    );
  }

  return out;
}

export function patchQualifiedExecutionRoute(source) {
  if (source.includes('signalConfidence: finite(executionSignal.confidence)')) return source;
  return replaceRequired(
    source,
    "        manualExecution: true,\n        executionSource: 'qualified_signal_button_ict',",
    "        manualExecution: true,\n        signalConfidence: finite(executionSignal.confidence),\n        signalRR: finite(executionSignal.rr),\n        executionSource: 'qualified_signal_button_ict',",
    'qualified ICT confidence propagation',
  );
}

export function applyIctQualifiedGateConsistency(root = DEFAULT_ROOT) {
  const targets = [
    ['server/ictExecution.js', patchIctQualifiedExecution],
    ['server/index.js', patchIctInternalRoute],
    ['web/app/api/scanner/execute-qualified/route.ts', patchQualifiedExecutionRoute],
  ];
  const changed = [];

  for (const [relativePath, patcher] of targets) {
    const path = resolve(root, relativePath);
    if (!existsSync(path)) continue;
    const before = readFileSync(path, 'utf8');
    const after = patcher(before);
    if (after !== before) {
      writeFileSync(path, after, 'utf8');
      changed.push(relativePath);
    }
    console.log(`[ICT_QUALIFIED_GATE_FIX] verified ${relativePath}${after !== before ? ' (patched)' : ''}`);
  }

  return changed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  applyIctQualifiedGateConsistency();
}
