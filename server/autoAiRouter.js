/**
 * server/autoAiRouter.js
 *
 * Engine selection + routing for Auto AI Trading. A user runs EITHER the ICT
 * autonomous path OR the V3 autonomous path — never both in the same tick.
 * Mutual exclusivity is structural: there is a single `autoAiEngine` field.
 *
 *   resolveAutoEngine(settings) → 'ict' | 'v3' | null   (null = do nothing)
 *   runAutoForUser({ client, engine, ... })             → routes to exactly one
 */

import { runAutoAiForUser } from './ictAutoTrade.js';
import { runAutoV3ForUser } from './v3AutoTrade.js';

/**
 * Decide which engine (if any) to run for a user.
 *   - auto_ai_trading_enabled === false → null (nothing runs).
 *   - engine 'v3' → 'v3'.
 *   - anything else (incl. missing/invalid) → 'ict' (safe default).
 */
export function resolveAutoEngine({ autoAiTradingEnabled, autoAiEngine } = {}) {
  if (autoAiTradingEnabled !== true) return null;
  return String(autoAiEngine || 'ict').toLowerCase() === 'v3' ? 'v3' : 'ict';
}

/**
 * Run exactly one engine for one user. `runIct`/`runV3` are injectable for tests.
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
} = {}) {
  const ict = runIct || ((a) => runAutoAiForUser(a));
  const v3 = runV3 || ((a) => runAutoV3ForUser(a));
  const safePairs = Array.isArray(pairs) && pairs.length ? pairs : null;
  if (String(engine).toLowerCase() === 'v3') {
    return { engine: 'v3', ...(await v3({ client, now, runId, scanMode, pairs: safePairs })) };
  }
  return { engine: 'ict', ...(await ict({ client, now, runId, scanMode, pairs: safePairs })) };
}
