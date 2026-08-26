/**
 * server/autoAiRouter.js
 *
 * Engine selection + routing for Auto AI Trading. A user runs exactly one of:
 * ICT, independent raw-market V3, or independent raw-market PPR.
 *
 * Engine modules are loaded lazily only after selection. Selecting V3 therefore
 * does not initialize ICT or PPR strategy code, and injected test runners do not
 * load any production engine at all.
 */

import {
  autoAiExecutionWindowReason,
  autoAiWindowReason,
  inAutoAiExecutionWindow,
  inAutoAiScanWindow,
} from './autoAiWindow.js';

export function normalizeAutoEngine(value) {
  const engine = String(value || 'ict').toLowerCase();
  if (engine === 'v3' || engine === 'ppr') return engine;
  return 'ict';
}

/** Decide which engine (if any) runs for one user. */
export function resolveAutoEngine({ autoAiTradingEnabled, autoAiEngine } = {}) {
  if (autoAiTradingEnabled !== true) return null;
  return normalizeAutoEngine(autoAiEngine);
}

function outsideWindowResult(engine) {
  return {
    engine,
    scanned: 0,
    qualified: 0,
    executed: [],
    skipped: [{ reason: autoAiWindowReason() }],
    nearQualifiedPairs: [],
    hotPairs: [],
    lateEntryPairs: [],
    executionAllowed: false,
  };
}

async function resolveRunner(engine, injectedRunner) {
  if (injectedRunner) return injectedRunner;

  if (engine === 'v3') {
    const module = await import('./v3AutoTrade.js');
    return module.runAutoV3ForUser;
  }
  if (engine === 'ppr') {
    const module = await import('./pprAutoTrade.js');
    return module.runAutoPprForUser;
  }

  const module = await import('./ictAutoTrade.js');
  return module.runAutoAiForUser;
}

/** Run exactly one selected engine for one user. */
export async function runAutoForUser({
  client,
  engine,
  now = new Date(),
  runId = null,
  scanMode = 'full',
  pairs = null,
  targetRiskUSD = null,
  manualExecution = false,
  runIct = null,
  runV3 = null,
  runPpr = null,
} = {}) {
  const selectedEngine = normalizeAutoEngine(engine);
  const dailyStudy = scanMode === 'daily_study';

  if (!dailyStudy && !inAutoAiScanWindow(now)) return outsideWindowResult(selectedEngine);

  const safePairs = Array.isArray(pairs) && pairs.length ? pairs : null;
  const executionAllowed = !dailyStudy && inAutoAiExecutionWindow(now, selectedEngine);
  const args = {
    client,
    now,
    runId,
    scanMode,
    pairs: safePairs,
    targetRiskUSD,
    manualExecution,
    executionAllowed,
    executionBlockedReason: executionAllowed
      ? null
      : dailyStudy
        ? 'daily_market_study_never_submits_orders'
        : autoAiExecutionWindowReason(selectedEngine),
  };
  const injectedRunner = selectedEngine === 'v3'
    ? runV3
    : selectedEngine === 'ppr'
      ? runPpr
      : runIct;
  const runner = await resolveRunner(selectedEngine, injectedRunner);
  const result = await runner(args);

  if (!dailyStudy && !executionAllowed) {
    const potentialQualified = Number.isFinite(Number(result?.qualified))
      ? Math.max(0, Number(result.qualified))
      : 0;
    const existingWatching = Number.isFinite(Number(result?.watching))
      ? Math.max(0, Number(result.watching))
      : Number.isFinite(Number(result?.watchCount))
        ? Math.max(0, Number(result.watchCount))
        : Number.isFinite(Number(result?.qualityWatch))
          ? Math.max(0, Number(result.qualityWatch))
          : 0;
    const scanned = Number.isFinite(Number(result?.scanned))
      ? Math.max(0, Number(result.scanned))
      : existingWatching + potentialQualified;
    const blockedReason = String(args.executionBlockedReason || '');
    const skipped = Array.isArray(result?.skipped)
      ? result.skipped.filter((item) => String(item?.reason || '') !== blockedReason)
      : [];

    return {
      engine: selectedEngine,
      ...result,
      qualified: 0,
      watching: Math.min(scanned || existingWatching + potentialQualified, existingWatching + potentialQualified),
      executed: [],
      skipped,
      executionAllowed: false,
      qualificationAllowed: false,
      preOpenScanOnly: true,
      preOpenPotentialQualified: potentialQualified,
      v3Promoted: Object.hasOwn(result || {}, 'v3Promoted') ? 0 : result?.v3Promoted,
      independentV3Qualified: Object.hasOwn(result || {}, 'independentV3Qualified') ? 0 : result?.independentV3Qualified,
    };
  }

  return {
    engine: selectedEngine,
    ...result,
    executionAllowed,
    qualificationAllowed: !dailyStudy && executionAllowed,
  };
}
