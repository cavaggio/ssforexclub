/**
 * server/autoAiRouter.js
 *
 * Engine selection + routing for Auto AI Trading. A user runs exactly one of:
 * ICT, independent raw-market V3, or independent raw-market PPR.
 *
 * This router may know that the engines exist, but no engine is allowed to call
 * or fall through to another engine. Scheduling policy is engine-neutral.
 */

import { runAutoAiForUser } from './ictAutoTrade.js';
import { runAutoV3ForUser } from './v3AutoTrade.js';
import { runAutoPprForUser } from './pprAutoTrade.js';
import { autoAiWindowReason, inAutoAiWindow } from './autoAiWindow.js';

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
  };
}

/**
 * Run exactly one engine for one user. Injected runners make engine isolation
 * directly testable and prevent accidental multi-engine execution.
 */
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

  if (!inAutoAiWindow(now)) return outsideWindowResult(selectedEngine);

  const safePairs = Array.isArray(pairs) && pairs.length ? pairs : null;
  const args = { client, now, runId, scanMode, pairs: safePairs };

  if (selectedEngine === 'v3') {
    const runner = runV3 || runAutoV3ForUser;
    return { engine: 'v3', ...(await runner(args)) };
  }
  if (selectedEngine === 'ppr') {
    const runner = runPpr || runAutoPprForUser;
    return { engine: 'ppr', ...(await runner(args)) };
  }

  const runner = runIct || runAutoAiForUser;
  return { engine: 'ict', ...(await runner(args)) };
}
