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
  runIct = null,
  runV3 = null,
  runPpr = null,
} = {}) {
  const selectedEngine = normalizeAutoEngine(engine);

  if (!inAutoAiScanWindow(now)) return outsideWindowResult(selectedEngine);

  const safePairs = Array.isArray(pairs) && pairs.length ? pairs : null;
  const executionAllowed = inAutoAiExecutionWindow(now);
  const args = {
    client,
    now,
    runId,
    scanMode,
    pairs: safePairs,
    executionAllowed,
    executionBlockedReason: executionAllowed ? null : autoAiExecutionWindowReason(),
  };
  const injectedRunner = selectedEngine === 'v3'
    ? runV3
    : selectedEngine === 'ppr'
      ? runPpr
      : runIct;
  const runner = await resolveRunner(selectedEngine, injectedRunner);
  const result = await runner(args);

  return { engine: selectedEngine, executionAllowed, ...result };
}
