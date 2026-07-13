import { executeTrade } from './oandaTrade.js';
import { applyScalpMetadata } from './scalpOnlyPolicy.js';
import { DEFAULT_V3_FOREX_WATCHLIST, scanV3Watchlist } from './v3NativeScanner.js';
import { V3_PRIMARY_ALIGNMENT_MIN_SCORE } from './v3PrimaryAlignment.js';

function maskAccount(id) {
  return id && id.length > 4 ? `${id.slice(0, 3)}…${id.slice(-3)}` : '***';
}

function ensureDedicatedV3Watchlist() {
  if (String(process.env.V3_FOREX_WATCHLIST || '').trim()) return;
  process.env.V3_FOREX_WATCHLIST = DEFAULT_V3_FOREX_WATCHLIST.join(',');
}

/**
 * Native V3 autonomous runner.
 *
 * It never calls oandaScanner/scanForexPairs and never consumes a legacy
 * qualified or rejected array. V3 fetches and evaluates its own watchlist data.
 */
export async function runAutoV3ForUser({
  client,
  now = new Date(),
  runId = null,
  scanMode = 'full',
  pairs = null,
} = {}) {
  ensureDedicatedV3Watchlist();

  const tag = `[AUTO_AI][V3_NATIVE][runId=${runId ?? '-'}]`;
  const account = maskAccount(client?.accountId);
  const log = (message) => console.log(`${tag} account=${account} ${message}`);

  const scan = await scanV3Watchlist({ client, now, scanMode, pairs, log });
  const executable = scan.qualified.map((signal) => applyScalpMetadata({
    ...signal,
    source: 'v3_native_auto_ai',
    strategy: 'V3',
    tradeStyle: 'SCALP',
    scalpOnly: true,
    selectedLogicType: 'v3_pure',
  }));

  const executed = [];
  const skipped = [];

  for (const signal of executable) {
    const alignment = signal?.primaryTimeframeAlignment;
    const alignmentScore = Number(alignment?.score);

    // Final defensive boundary immediately before order submission.
    if (alignment?.passed !== true || !Number.isFinite(alignmentScore)
      || alignmentScore < V3_PRIMARY_ALIGNMENT_MIN_SCORE) {
      const reason = `V3 native execution rejected: Daily/H4/M15 score ${Number.isFinite(alignmentScore) ? alignmentScore : 'missing'} < ${V3_PRIMARY_ALIGNMENT_MIN_SCORE}`;
      skipped.push({ pair: signal?.pair, reason });
      log(`execution skipped pair=${signal?.pair || 'unknown'} reason="${reason}"`);
      continue;
    }

    signal.environment = client?.environment || signal.environment;
    const result = await executeTrade(signal, { client, autoAi: true });

    if (!result?.success) {
      const reason = result?.reason || result?.rejectReason || 'not executed';
      skipped.push({ pair: signal?.pair, reason });
      log(`execution skipped pair=${signal?.pair || 'unknown'} reason="${reason}"`);
      continue;
    }

    executed.push({
      pair: signal.pair,
      direction: signal.direction,
      tradeId: result.tradeId,
      fillPrice: result.fillPrice,
      units: result.units,
      stopLoss: result.sizing?.stopLoss ?? signal.stopLoss,
      takeProfit: result.sizing?.takeProfit ?? signal.takeProfit,
      confidence: result.tpHitConfidence ?? signal.tpHitConfidence ?? signal.confidence,
      tpHitConfidence: result.tpHitConfidence ?? signal.tpHitConfidence ?? signal.confidence,
      entryQualityConfidence: signal.entryQualityConfidence ?? null,
      actualFillRR: result.actualFillRR ?? result.sizing?.riskReward ?? null,
      postFillTpAdjusted: result.postFillTpAdjusted === true,
      expectedRR: signal.expectedRR ?? signal.rr,
      primaryTimeframeAlignment: signal.primaryTimeframeAlignment,
      source: signal.source,
      strategy: 'V3',
      signal,
    });
    log(`trade executed pair=${signal.pair} dir=${signal.direction} id=${result.tradeId}`);
  }

  log(
    `scan complete scanned=${scan.scanned} qualified=${executable.length} ` +
    `executed=${executed.length} skipped=${skipped.length} watches=${scan.watchCandidates.length}`,
  );

  return {
    engine: 'v3',
    scanner: 'v3_native',
    scanned: scan.scanned,
    reviewedPairs: scan.pairs,
    qualified: executable.length,
    rejected: scan.rejected.length,
    executed,
    skipped,
    v3Promoted: executable.length,
    qualityWatch: scan.watchCandidates.length,
    watchCandidates: scan.watchCandidates,
    nearQualifiedPairs: scan.nearQualifiedPairs,
    hotPairs: scan.hotPairs,
    lateEntryPairs: scan.lateEntryPairs,
    scanMeta: scan.meta,
  };
}
