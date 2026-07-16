import { scanV3IndependentMarket } from './v3IndependentScanner.js';
import { executeTrade } from './oandaTrade.js';
import { applyScalpMetadata } from './scalpOnlyPolicy.js';

/**
 * Autonomous V3 runner for one authenticated OANDA user.
 *
 * Architecture rule: V3 reads raw OANDA pricing/candles through
 * scanV3IndependentMarket(). It does not call oandaScanner, consume legacy
 * qualified/rejected arrays, inherit legacy direction, blend legacy confidence,
 * or read a shared legacy retrace-watch registry.
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
    'legacyScannerUsed=false sharedRetraceWatchUsed=false',
  );

  const scan = await scanV3IndependentMarket({
    pairs: scanPairs,
    client,
    now,
    scanMode,
    log,
  });

  const qualified = (Array.isArray(scan?.qualified) ? scan.qualified : []).map((signal) =>
    applyScalpMetadata({
      ...signal,
      source: 'v3_pure_auto_ai',
      strategy: 'V3',
      engine: 'v3',
      tradeStyle: 'SCALP',
      scalpOnly: true,
      selectedLogicType: 'v3_pure',
      architecture: 'independent_v3_raw_market_data',
      legacyScannerUsed: false,
      legacyDirection: null,
      sharedRetraceWatchUsed: false,
    }),
  );

  const stageWatchCandidates = Array.isArray(scan?.watchCandidates)
    ? scan.watchCandidates
    : [];
  const watchState = buildIndependentWatchState(scan, qualified);

  if (!qualified.length) {
    log(
      `independent scan complete qualified=0 executed=0 skipped=0 ` +
      `qualityWatch=${stageWatchCandidates.length} legacyScannerUsed=false`,
    );
    return {
      engine: 'v3',
      architecture: 'independent_v3_raw_market_data',
      legacyScannerUsed: false,
      sharedRetraceWatchUsed: false,
      scanned: scan?.meta?.pairsScanned ?? 0,
      qualified: 0,
      executed: [],
      skipped: [],
      v3Promoted: 0,
      independentV3Qualified: 0,
      qualityWatch: stageWatchCandidates.length,
      watchCandidates: stageWatchCandidates,
      ...watchState,
    };
  }

  const executed = [];
  const skipped = [];

  for (const signal of qualified) {
    signal.environment = client?.environment || signal.environment;
    const result = await executeTrade(signal, { client, autoAi: true });

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
        legacyScannerUsed: false,
        sharedRetraceWatchUsed: false,
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
    `skipped=${skipped.length} qualityWatch=${stageWatchCandidates.length} legacyScannerUsed=false`,
  );

  return {
    engine: 'v3',
    architecture: 'independent_v3_raw_market_data',
    legacyScannerUsed: false,
    sharedRetraceWatchUsed: false,
    scanned: scan?.meta?.pairsScanned ?? qualified.length,
    qualified: qualified.length,
    executed,
    skipped,
    v3Promoted: qualified.length,
    independentV3Qualified: qualified.length,
    qualityWatch: stageWatchCandidates.length,
    watchCandidates: stageWatchCandidates,
    ...watchState,
  };
}

// June 23 soft-filter scoring remains exported for compatibility with existing
// tests and diagnostics. It is not used to source or qualify independent V3
// candidates.
export function applyJune23SoftFilterScoring(candidate = {}) {
  let confidenceAdjustment = 0;
  const softReasons = [];

  if (candidate.regimeAligned === true) {
    confidenceAdjustment += 1;
    softReasons.push('Regime aligned: +1 confidence');
  } else if (candidate.regimeAligned === false) {
    confidenceAdjustment -= 1;
    softReasons.push('Regime not aligned: -1 confidence');
  }

  if (candidate.liquidityIntentStrong === true) {
    confidenceAdjustment += 2;
    softReasons.push('Strong liquidity intent: +2 confidence');
  } else if (candidate.liquidityIntentStrong === false) {
    confidenceAdjustment -= 1;
    softReasons.push('Weak liquidity intent: -1 confidence');
  }

  if (candidate.calibrationPositive === true) {
    confidenceAdjustment += 1;
    softReasons.push('Positive calibration: +1 confidence');
  } else if (candidate.calibrationPositive === false) {
    confidenceAdjustment -= 1;
    softReasons.push('Negative calibration: -1 confidence');
  }

  if (candidate.smtDivergence === true) {
    confidenceAdjustment += 1;
    softReasons.push('SMT divergence present: +1 confidence');
  }

  if (candidate.sessionNarrativeAligned === true) {
    confidenceAdjustment += 1;
    softReasons.push('Session narrative aligned: +1 confidence');
  }

  const baseConfidence = Number(candidate.confidence ?? 0);
  const confidence = Math.max(0, Math.min(100, baseConfidence + confidenceAdjustment));

  return {
    ...candidate,
    baseConfidence,
    confidence,
    confidenceAdjustment,
    softReasons,
  };
}
