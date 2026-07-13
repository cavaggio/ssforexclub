/** V3 autonomous runner: legacy-qualified candidates only, minimum 67 alignment. */
import { getRetraceWatchPairs } from './retraceWatchMode.js';
import { scanForexPairs } from './oandaScanner.js';
import { executeTrade } from './oandaTrade.js';
import { applyScalpMetadata } from './scalpOnlyPolicy.js';
import { promoteLegacyQualifiedForV3 } from './v3QualifiedPromotion.js';
export { applyJune23SoftFilterScoring } from './v3SoftFilterScoring.js';
export {
  V3_LEGACY_MIN_PRIMARY_ALIGNMENT_SCORE,
  getLegacyPrimaryAlignmentScore,
  selectV3ReviewCandidates,
} from './v3LegacyBoundary.js';
export { promoteLegacyQualifiedForV3 } from './v3QualifiedPromotion.js';

function mask(id) { return id && id.length > 4 ? `${id.slice(0, 3)}…${id.slice(-3)}` : '***'; }
function enabled(value) { return ['1', 'true', 'yes', 'on'].includes(String(value ?? false).toLowerCase()); }
function prioritized(pairs = []) { return [...new Set([...getRetraceWatchPairs(), ...(Array.isArray(pairs) ? pairs : [])])]; }

export async function runAutoV3ForUser({ client, now = new Date(), runId = null,
  scanMode = 'full', pairs = null } = {}) {
  void now;
  const tag = `[AUTO_AI][V3][runId=${runId ?? '-'}]`;
  const log = (message) => console.log(`${tag} account=${mask(client?.accountId)} engine=v3 ${message}`);
  const requested = Array.isArray(pairs) && pairs.length ? prioritized(pairs) : null;
  const scan = await scanForexPairs(requested, { client, scanMode });
  const batch = promoteLegacyQualifiedForV3(scan, log);
  const watchCandidates = Array.isArray(batch.watchCandidates) ? batch.watchCandidates : [];
  const promoted = batch.map((signal) => applyScalpMetadata({ ...signal,
    source: 'v3_pure_auto_ai', strategy: 'V3', tradeStyle: 'SCALP',
    scalpOnly: true, selectedLogicType: 'v3_pure' }));

  if (enabled(process.env.FOREX_V3_AUTO_USE_LEGACY_QUALIFIED)) {
    log('legacy-qualified pass-through ignored; V3 quality confirmation is mandatory');
  }

  const executed = [];
  const skipped = [];
  for (const signal of promoted) {
    signal.environment = client?.environment || signal.environment;
    const result = await executeTrade(signal, { client, autoAi: true });
    if (!result?.success) {
      skipped.push({ pair: signal.pair, reason: result?.reason || result?.rejectReason || 'not executed' });
      continue;
    }
    executed.push({ pair: signal.pair, direction: signal.direction, tradeId: result.tradeId,
      fillPrice: result.fillPrice, units: result.units,
      stopLoss: result.sizing?.stopLoss ?? signal.stopLoss,
      takeProfit: result.sizing?.takeProfit ?? signal.takeProfit,
      tpHitConfidence: result.tpHitConfidence ?? signal.tpHitConfidence,
      legacyPrimaryAlignmentScore: signal.legacyPrimaryAlignmentScore,
      expectedRR: signal.expectedRR ?? signal.rr, source: signal.source,
      strategy: signal.strategy ?? 'V3', signal });
  }

  return { engine: 'v3', scanned: scan?.meta?.pairsScanned ?? 0,
    qualified: promoted.length, executed, skipped, v3Promoted: promoted.length,
    qualityWatch: watchCandidates.length, watchCandidates,
    nearQualifiedPairs: [...new Set(watchCandidates.map((x) => x?.pair).filter(Boolean))],
    hotPairs: [...new Set(promoted.map((x) => x?.pair).filter(Boolean))],
    lateEntryPairs: [] };
}
