import { executeTrade } from './oandaTrade.js';
import { applyScalpMetadata } from './scalpOnlyPolicy.js';
import { DEFAULT_V3_FOREX_WATCHLIST, scanV3Watchlist } from './v3NativeScanner.js';
import { V3_PRIMARY_ALIGNMENT_MIN_SCORE } from './v3PrimaryAlignment.js';

export const V3_STAGE1_MIN_SCORE = 62;

function maskAccount(id) {
  return id && id.length > 4 ? `${id.slice(0, 3)}…${id.slice(-3)}` : '***';
}

function ensureDedicatedV3Watchlist() {
  if (String(process.env.V3_FOREX_WATCHLIST || '').trim()) return;
  process.env.V3_FOREX_WATCHLIST = DEFAULT_V3_FOREX_WATCHLIST.join(',');
}

function enforceV3RuntimePolicy() {
  // The requested V3 Stage 1 score floor is authoritative. This prevents an
  // older Railway environment value (for example 65) from silently overriding
  // the current 62-point production rule.
  process.env.V3_QUALITY_SETUP_MIN_SCORE = String(V3_STAGE1_MIN_SCORE);
}

function compactReasons(reasons = []) {
  return Array.isArray(reasons) && reasons.length > 0 ? reasons.join(' | ') : 'none';
}

function logWatchCandidate(candidate, tier, log) {
  const stage1 = candidate?.qualityConfirmation?.stage1 || {};
  const stage2 = candidate?.qualityConfirmation?.stage2 || {};
  const metrics = stage1?.metrics || {};

  log(
    `[V3_NATIVE_WATCH_DETAIL] pair=${candidate?.pair || 'unknown'} tier=${tier} ` +
    `timing=${candidate?.entryTiming?.status || 'unknown'} ` +
    `score=${metrics.score ?? 'n/a'}/${metrics.minScore ?? V3_STAGE1_MIN_SCORE} ` +
    `tpHit=${metrics.tpHitConfidence ?? candidate?.tpHitConfidence ?? 'n/a'}/${metrics.minTpHitConfidence ?? 'n/a'} ` +
    `rr=${metrics.rr ?? candidate?.expectedRR ?? candidate?.rr ?? 'n/a'}/${metrics.minRR ?? 'n/a'} ` +
    `stage1Reasons="${compactReasons(stage1.reasons)}" ` +
    `stage2Reasons="${compactReasons(stage2.reasons)}"`,
  );
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
  enforceV3RuntimePolicy();

  const tag = `[AUTO_AI][V3_NATIVE][runId=${runId ?? '-'}]`;
  const account = maskAccount(client?.accountId);
  const log = (message) => console.log(`${tag} account=${account} ${message}`);

  log(`[V3_NATIVE_POLICY] stage1MinScore=${V3_STAGE1_MIN_SCORE}`);

  const scan = await scanV3Watchlist({ client, now, scanMode, pairs, log });

  for (const candidate of scan.watchCandidates || []) {
    logWatchCandidate(candidate, 'near', log);
  }
  for (const candidate of scan.hotWatchCandidates || []) {
    logWatchCandidate(candidate, 'hot', log);
  }

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

    if (signal?.entryTiming?.status !== 'valid_entry') {
      const reason = `V3 native execution rejected: entry timing is ${signal?.entryTiming?.status || 'missing'}, not valid_entry`;
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
      entryTiming: signal.entryTiming,
      source: signal.source,
      strategy: 'V3',
      signal,
    });
    log(`trade executed pair=${signal.pair} dir=${signal.direction} id=${result.tradeId}`);
  }

  log(
    `scan complete scanned=${scan.scanned} qualified=${executable.length} ` +
    `executed=${executed.length} skipped=${skipped.length} ` +
    `near=${scan.watchCandidates.length} hot=${scan.hotWatchCandidates.length}`,
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
    qualityWatch: scan.watchCandidates.length + scan.hotWatchCandidates.length,
    watchCandidates: scan.watchCandidates,
    hotWatchCandidates: scan.hotWatchCandidates,
    nearQualifiedPairs: scan.nearQualifiedPairs,
    hotPairs: scan.hotPairs,
    lateEntryPairs: scan.lateEntryPairs,
    scanMeta: scan.meta,
  };
}
