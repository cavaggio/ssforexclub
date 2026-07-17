import { scanPprMarket } from './pprEngine.js';
import { executePprTrade } from './pprExecution.js';

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

export async function runAutoPprForUser({
  client,
  now = new Date(),
  runId = null,
  scanMode = 'full',
  pairs = null,
} = {}) {
  const tag = `[AUTO_AI][PPR][runId=${runId ?? '-'}]`;
  const account = maskAccount(client?.accountId);
  const log = (message) => console.log(`${tag} account=${account} engine=ppr ${message}`);
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

  if (!qualified.length) {
    log(`scan complete qualified=0 executed=0 skipped=0 watch=${scan?.watchCandidates?.length || 0}`);
    return {
      engine: 'ppr',
      architecture: 'independent_ppr_raw_market_data',
      legacyScannerUsed: false,
      v3LogicUsed: false,
      ictLogicUsed: false,
      scanned: scan?.meta?.pairsScanned ?? 0,
      qualified: 0,
      executed: [],
      skipped: [],
      watchCandidates: scan?.watchCandidates || [],
      rejected: scan?.rejected || [],
      ...watchState,
    };
  }

  const executed = [];
  const skipped = [];
  for (const candidate of qualified) {
    const result = await executePprTrade(candidate, { client, now: new Date(), log });
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
        signal: result.signal || candidate,
      });
      log(`trade executed pair=${candidate.pair} dir=${candidate.direction} id=${result.tradeId}`);
    } else {
      const reason = result?.reason || result?.rejectReason || 'not executed';
      skipped.push({ pair: candidate.pair, direction: candidate.direction, reason });
      log(`execution skipped pair=${candidate.pair} dir=${candidate.direction} reason="${reason}"`);
    }
  }

  log(`scan complete qualified=${qualified.length} executed=${executed.length} skipped=${skipped.length}`);
  return {
    engine: 'ppr',
    architecture: 'independent_ppr_raw_market_data',
    legacyScannerUsed: false,
    v3LogicUsed: false,
    ictLogicUsed: false,
    scanned: scan?.meta?.pairsScanned ?? qualified.length,
    qualified: qualified.length,
    executed,
    skipped,
    watchCandidates: scan?.watchCandidates || [],
    rejected: scan?.rejected || [],
    ...watchState,
  };
}
