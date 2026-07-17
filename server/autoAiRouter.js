/**
 * server/autoAiRouter.js
 *
 * Engine selection + routing for Auto AI Trading. A user runs exactly one of:
 * ICT, independent raw-market V3, or independent raw-market PPR.
 */

import { runAutoAiForUser } from './ictAutoTrade.js';
import { runAutoV3ForUser } from './v3AutoTrade.js';
import { runAutoPprForUser } from './pprAutoTrade.js';
import { inAutoAiWindow } from './ictAutoScheduler.js';

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
    skipped: [{ reason: 'outside_auto_ai_execution_window_02:00-10:00_ET_weekdays' }],
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

  // Final defense-in-depth gate: no Auto AI scan or execution may run outside
  // 02:00–10:00 America/New_York, Monday through Friday.
  if (!inAutoAiWindow(now)) return outsideWindowResult(selectedEngine);

  const ict = runIct || ((args) => runAutoAiForUser(args));
  const v3 = runV3 || ((args) => runAutoV3ForUser(args));
  const ppr = runPpr || ((args) => runAutoPprForUser(args));
  const safePairs = Array.isArray(pairs) && pairs.length ? pairs : null;
  const args = { client, now, runId, scanMode, pairs: safePairs };

  if (selectedEngine === 'v3') return { engine: 'v3', ...(await v3(args)) };
  if (selectedEngine === 'ppr') return { engine: 'ppr', ...(await ppr(args)) };
  return { engine: 'ict', ...(await ict(args)) };
}
