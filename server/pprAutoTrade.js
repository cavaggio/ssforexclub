import { scanPprMarket } from './pprEngine.js';
import { executePprTrade } from './pprExecution.js';
import { pprRuntimeConfig } from './pprEnv.js';

function maskAccount(id) {
  return id && id.length > 4 ? `${id.slice(0, 3)}…${id.slice(-3)}` : '***';
}

function pairOf(item) {
  return item?.pair || item?.instrument || item?.symbol || null;
}

function buildPprWatchState(scan) {
  const hotPairs = new Set();
  const nearQualifiedPairs = new Set();
  const lateEntryPairs = new Set();

  for (const item of Array.isArray(scan?.watchCandidates) ? scan.watchCandidates : []) {
    const pair = pairOf(item);
    if (!pair) continue;
    if (item.status === 'hot') hotPairs.add(pair);
    else nearQualifiedPairs.add(pair);
  }
  for (const item of Array.isArray(scan?.rejected) ? scan.rejected : []) {
    const pair = pairOf(item);
    if (!pair) continue;
    const reason = String(item?.reason || '').toLowerCase();
    if (reason.includes('late') || reason.includes('stale')) lateEntryPairs.add(pair);
  }
  for (const pair of lateEntryPairs) {
    hotPairs.delete(pair);
    nearQualifiedPairs.delete(pair);
  }
  return {
    hotPairs: [...hotPairs],
    nearQualifiedPairs: [...nearQualifiedPairs],
    lateEntryPairs: [...lateEntryPairs],
  };
}

function scanSummary(scan) {
  const qualifiedCount = Array.isArray(scan?.qualified) ? scan.qualified.length : 0;
  const watchCount = Array.isArray(scan?.watchCandidates) ? scan.watchCandidates.length : 0;
  const rejectedCount = Array.isArray(scan?.rejected) ? scan.rejected.length : 0;
  const accountedFor = qualifiedCount + watchCount + rejectedCount;
  const scanned = Number(scan?.meta?.pairsScanned ?? accountedFor);
  return {
    scanned,
    qualifiedCount,
    watchCount,
    rejectedCount,
    accountedFor,
    countInvariantOk: scanned === accountedFor,
    executionReadiness: scan?.meta?.executionReadiness ?? null,
  };
}

function disabledResult({ runtime, reason }) {
  return {
    engine: 'ppr',
    architecture: 'independent_ppr_raw_market_data',
    legacyScannerUsed: false,
    v3LogicUsed: false,
    ictLogicUsed: false,
    scanned: 0,
    qualified: 0,
    watching: 0,
    rejectedCount: 0,
    accountedFor: 0,
    countInvariantOk: true,
    executionReadiness: null,
    executed: [],
    skipped: [{ reason }],
    watchCandidates: [],
    rejected: [],
    hotPairs: [],
    nearQualifiedPairs: [],
    lateEntryPairs: [],
    pprRuntime: runtime,
    autoManageEnabled: runtime.aiAutoManageEnabled,
  };
}

export async function runAutoPprForUser({
  client,
  now = new Date(),
  runId = null,
  scanMode = 'full',
  pairs = null,
  targetRiskUSD = null,
  manualExecution = false,
} = {}) {
  const tag = `[AUTO_AI][PPR][runId=${runId ?? '-'}]`;
  const account = maskAccount(client?.accountId);
  const log = (message) => console.log(`${tag} account=${account} engine=ppr ${message}`);
  const runtime = pprRuntimeConfig();

  log(
    `runtime engineMode=${runtime.engineMode} active=${runtime.engineActive} ` +
    `autoExecution=${runtime.aiAutoExecutionEnabled} autoManage=${runtime.aiAutoManageEnabled}`,
  );

  if (!runtime.engineActive) {
    const reason = `PPR engine inactive (PPR_ENGINE_MODE=${runtime.engineMode})`;
    log(`skipped reason="${reason}"`);
    return disabledResult({ runtime, reason });
  }

  const scanPairs = Array.isArray(pairs) && pairs.length
    ? [...new Set(pairs.map((pair) => String(pair).trim().toUpperCase()).filter(Boolean))]
    : null;

  log(
    `independent scan started scanMode=${scanMode} ` +
    `pairs=${scanPairs?.length ? scanPairs.join(',') : 'PPR_WATCHLIST'} ` +
    'legacyScannerUsed=false v3LogicUsed=false ictLogicUsed=false',
  );

  const scan = await scanPprMarket({ pairs: scanPairs, client, now, log });
  const qualified = Array.isArray(scan?.qualified) ? scan.qualified : [];
  const watchState = buildPprWatchState(scan);
  const counts = scanSummary(scan);

  if (!qualified.length) {
    log(
      `scan complete scanned=${counts.scanned} qualified=0 watching=${counts.watchCount} ` +
      `rejected=${counts.rejectedCount} accounted=${counts.accountedFor} ` +
      `countInvariantOk=${counts.countInvariantOk} executed=0 skipped=0`,
    );
    return {
      engine: 'ppr',
      architecture: 'independent_ppr_raw_market_data',
      legacyScannerUsed: false,
      v3LogicUsed: false,
      ictLogicUsed: false,
      scanned: counts.scanned,
      qualified: 0,
      watching: counts.watchCount,
      rejectedCount: counts.rejectedCount,
      accountedFor: counts.accountedFor,
      countInvariantOk: counts.countInvariantOk,
      executionReadiness: counts.executionReadiness,
      executed: [],
      skipped: [],
      watchCandidates: scan?.watchCandidates || [],
      rejected: scan?.rejected || [],
      pprRuntime: runtime,
      autoManageEnabled: runtime.aiAutoManageEnabled,
      ...watchState,
    };
  }

  if (!runtime.aiAutoExecutionEnabled) {
    const skipped = qualified.map((candidate) => ({
      pair: candidate.pair,
      direction: candidate.direction,
      reason: 'PPR AI auto execution disabled (PPR_AI_AUTO_EXECUTION_ENABLED=false)',
    }));
    log(
      `scan complete scanned=${counts.scanned} qualified=${qualified.length} watching=${counts.watchCount} ` +
      `rejected=${counts.rejectedCount} accounted=${counts.accountedFor} ` +
      `countInvariantOk=${counts.countInvariantOk} executed=0 skipped=${skipped.length}`,
    );
    return {
      engine: 'ppr',
      architecture: 'independent_ppr_raw_market_data',
      legacyScannerUsed: false,
      v3LogicUsed: false,
      ictLogicUsed: false,
      scanned: counts.scanned,
      qualified: qualified.length,
      watching: counts.watchCount,
      rejectedCount: counts.rejectedCount,
      accountedFor: counts.accountedFor,
      countInvariantOk: counts.countInvariantOk,
      executionReadiness: counts.executionReadiness,
      executed: [],
      skipped,
      watchCandidates: scan?.watchCandidates || [],
      rejected: scan?.rejected || [],
      pprRuntime: runtime,
      autoManageEnabled: runtime.aiAutoManageEnabled,
      ...watchState,
    };
  }

  const executed = [];
  const skipped = [];
  for (const candidate of qualified) {
    const executionCandidate = manualExecution && Number.isFinite(Number(targetRiskUSD))
      ? { ...candidate, targetRiskUSD: Number(targetRiskUSD), riskPercent: 1.25 }
      : candidate;
    const result = await executePprTrade(executionCandidate, {
      client,
      now: new Date(),
      log,
      targetRiskUSD,
      manualExecution,
    });
    if (result?.success) {
      executed.push({
        pair: candidate.pair,
        direction: candidate.direction,
        tradeId: result.tradeId,
        fillPrice: result.fillPrice,
        units: result.units,
        stopLoss: result.sizing?.stopLoss ?? candidate.stopLoss,
        takeProfit: result.sizing?.takeProfit ?? candidate.takeProfit,
        confidence: candidate.confidence,
        expectedRR: candidate.expectedRR,
        manipulationType: candidate.pprConfirmation?.manipulationType || null,
        strategy: 'PPR',
        architecture: 'independent_ppr_raw_market_data',
        signal: result.signal || executionCandidate,
      });
      log(`trade executed pair=${candidate.pair} dir=${candidate.direction} id=${result.tradeId}`);
    } else {
      const reason = result?.reason || result?.rejectReason || 'not executed';
      skipped.push({ pair: candidate.pair, direction: candidate.direction, reason });
      log(`execution skipped pair=${candidate.pair} dir=${candidate.direction} reason="${reason}"`);
    }
  }

  log(
    `scan complete scanned=${counts.scanned} qualified=${qualified.length} watching=${counts.watchCount} ` +
    `rejected=${counts.rejectedCount} accounted=${counts.accountedFor} ` +
    `countInvariantOk=${counts.countInvariantOk} executed=${executed.length} skipped=${skipped.length}`,
  );
  return {
    engine: 'ppr',
    architecture: 'independent_ppr_raw_market_data',
    legacyScannerUsed: false,
    v3LogicUsed: false,
    ictLogicUsed: false,
    scanned: counts.scanned,
    qualified: qualified.length,
    watching: counts.watchCount,
    rejectedCount: counts.rejectedCount,
    accountedFor: counts.accountedFor,
    countInvariantOk: counts.countInvariantOk,
    executionReadiness: counts.executionReadiness,
    executed,
    skipped,
    watchCandidates: scan?.watchCandidates || [],
    rejected: scan?.rejected || [],
    pprRuntime: runtime,
    autoManageEnabled: runtime.aiAutoManageEnabled,
    ...watchState,
  };
}
