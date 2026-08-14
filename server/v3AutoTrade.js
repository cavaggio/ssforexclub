import { scanV3IndependentMarket, refreshIndependentV3CandidateForExecution } from './v3IndependentScanner.js';
import { executeV3Trade } from './v3TradeExecution.js';
import { applyScalpMetadata } from './scalpOnlyPolicy.js';
import { applyCombinedLearningCalibration } from './engineTradeLearning.js';

/**
 * Autonomous V3 runner for one authenticated OANDA user.
 *
 * Architecture rule: V3 reads raw OANDA pricing/candles through
 * scanV3IndependentMarket(). It consumes no foreign-engine scanner output,
 * direction, confidence, qualification arrays, or watch registries.
 */

function maskAccount(id) {
  return id && id.length > 4 ? `${id.slice(0, 3)}…${id.slice(-3)}` : '***';
}

function pairOf(item) {
  return item?.pair || item?.instrument || item?.symbol || null;
}

function buildIndependentWatchState(scan, qualified = []) {
  const hotPairs = new Set(qualified.map(pairOf).filter(Boolean));
  const nearQualifiedPairs = new Set(
    (Array.isArray(scan?.watchCandidates) ? scan.watchCandidates : [])
      .map(pairOf)
      .filter(Boolean),
  );
  const lateEntryPairs = new Set();

  for (const item of Array.isArray(scan?.rejected) ? scan.rejected : []) {
    const pair = pairOf(item);
    if (!pair) continue;
    const text = JSON.stringify(item?.rejectionReasons || item?.reason || '').toLowerCase();
    if (text.includes('late') || text.includes('remaining opportunity')) {
      lateEntryPairs.add(pair);
      nearQualifiedPairs.delete(pair);
      hotPairs.delete(pair);
    }
  }

  return {
    hotPairs: [...hotPairs],
    nearQualifiedPairs: [...nearQualifiedPairs],
    lateEntryPairs: [...lateEntryPairs],
  };
}

export async function runAutoV3ForUser({
  client,
  now = new Date(),
  runId = null,
  scanMode = 'full',
  pairs = null,
  executionAllowed = true,
  executionBlockedReason = null,
} = {}) {
  const tag = `[AUTO_AI][V3][runId=${runId ?? '-'}]`;
  const account = maskAccount(client?.accountId);
  const log = (message) => console.log(`${tag} account=${account} engine=v3 ${message}`);
  const scanPairs = Array.isArray(pairs) && pairs.length
    ? [...new Set(pairs.map((pair) => String(pair).toUpperCase()))]
    : null;

  log(
    `independent scan started scanMode=${scanMode} ` +
    `pairs=${scanPairs?.length ? scanPairs.join(',') : 'V3_WATCHLIST'} ` +
    'foreignStrategyInputs=false',
  );

  const scan = await scanV3IndependentMarket({
    pairs: scanPairs,
    client,
    now,
    scanMode,
    log,
  });

  const qualified = await Promise.all(
    (Array.isArray(scan?.qualified) ? scan.qualified : []).map(async (signal) => {
      const calibrated = await applyCombinedLearningCalibration(signal, { client, engine: 'v3' });
      return applyScalpMetadata({
        ...calibrated,
        source: 'v3_pure_auto_ai',
        strategy: 'V3',
        engine: 'v3',
        tradeStyle: 'SCALP',
        scalpOnly: true,
        selectedLogicType: 'v3_pure',
        architecture: 'independent_v3_raw_market_data',
      });
    }),
  );

  const stageWatchCandidates = Array.isArray(scan?.watchCandidates)
    ? scan.watchCandidates
    : [];
  const watchState = buildIndependentWatchState(scan, qualified);

  if (!qualified.length) {
    log(
      `independent scan complete qualified=0 executed=0 skipped=0 ` +
      `qualityWatch=${stageWatchCandidates.length} foreignStrategyInputs=false`,
    );
    return {
      engine: 'v3',
      architecture: 'independent_v3_raw_market_data',
      scanned: scan?.meta?.pairsScanned ?? 0,
      qualified: 0,
      executed: [],
      skipped: [],
      v3Promoted: 0,
      independentV3Qualified: 0,
      qualityWatch: stageWatchCandidates.length,
      qualifiedCandidates: qualified,
      watchCandidates: stageWatchCandidates,
      rejected: scan?.rejected || [],
      ...watchState,
    };
  }

  if (executionAllowed === false) {
    const reason = executionBlockedReason || 'scan_only_until_02:30_ET_no_new_orders';
    const skipped = qualified.map((signal) => ({
      pair: signal.pair,
      direction: signal.direction,
      reason,
    }));
    log(`scan-only gate active qualified=${qualified.length} executed=0 reason="${reason}"`);
    return {
      engine: 'v3',
      architecture: 'independent_v3_raw_market_data',
      scanned: scan?.meta?.pairsScanned ?? qualified.length,
      qualified: qualified.length,
      executed: [],
      skipped,
      executionAllowed: false,
      v3Promoted: qualified.length,
      independentV3Qualified: qualified.length,
      qualityWatch: stageWatchCandidates.length,
      qualifiedCandidates: qualified,
      watchCandidates: stageWatchCandidates,
      rejected: scan?.rejected || [],
      ...watchState,
    };
  }

  if (!executionAllowed) {
    const reason = executionBlockedReason || 'V3 scan-only window: new orders are not allowed yet';
    const skipped = qualified.map((candidate) => ({
      pair: candidate.pair, direction: candidate.direction, reason,
    }));
    log(`V3 scan-only window qualified=${qualified.length} executed=0 reason="${reason}"`);
    return {
      engine: 'v3',
      architecture: 'independent_v3_raw_market_data',
      scanned: scan?.meta?.pairsScanned ?? qualified.length,
      qualified: qualified.length,
      executed: [],
      skipped,
      v3Promoted: qualified.length,
      independentV3Qualified: qualified.length,
      qualityWatch: stageWatchCandidates.length,
      qualifiedCandidates: qualified,
      watchCandidates: stageWatchCandidates,
      rejected: scan?.rejected || [],
      ...watchState,
    };
  }

  const executed = [];
  const skipped = [];

  for (let signal of qualified) {
    const refreshed = await refreshIndependentV3CandidateForExecution({ candidate: signal, client, now: new Date(), log });
    if (!refreshed.allowed) {
      skipped.push({ pair: signal.pair, direction: signal.direction, reason: refreshed.reason });
      log(`execution skipped pair=${signal.pair} dir=${signal.direction} reason="${refreshed.reason}"`);
      continue;
    }
    const authoritativeCandidate = await applyCombinedLearningCalibration({
      ...signal,
      ...refreshed.candidate,
    }, { client, engine: 'v3' });
    signal = applyScalpMetadata({
      ...authoritativeCandidate,
      source: 'v3_pure_auto_ai',
      strategy: 'V3',
      engine: 'v3',
      tradeStyle: 'SCALP',
      scalpOnly: true,
      selectedLogicType: 'v3_pure',
      architecture: 'independent_v3_raw_market_data',
    });
    signal.environment = client?.environment || signal.environment;
    const result = await executeV3Trade(signal, { client });

    if (result?.success) {
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
        source: signal.source,
        strategy: 'V3',
        architecture: 'independent_v3_raw_market_data',
        signal,
      });
      log(`trade executed pair=${signal.pair} dir=${signal.direction} id=${result.tradeId}`);
    } else {
      const reason = result?.reason || result?.rejectReason || 'not executed';
      skipped.push({ pair: signal.pair, direction: signal.direction, reason });
      log(`execution skipped pair=${signal.pair} dir=${signal.direction} reason="${reason}"`);
    }
  }

  log(
    `independent scan complete qualified=${qualified.length} executed=${executed.length} ` +
    `skipped=${skipped.length} qualityWatch=${stageWatchCandidates.length} foreignStrategyInputs=false`,
  );

  return {
    engine: 'v3',
    architecture: 'independent_v3_raw_market_data',
    scanned: scan?.meta?.pairsScanned ?? qualified.length,
    qualified: qualified.length,
    executed,
    skipped,
    v3Promoted: qualified.length,
    independentV3Qualified: qualified.length,
    qualityWatch: stageWatchCandidates.length,
    qualifiedCandidates: qualified,
    watchCandidates: stageWatchCandidates,
    rejected: scan?.rejected || [],
    ...watchState,
  };
}
