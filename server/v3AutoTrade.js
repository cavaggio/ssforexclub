/**
 * server/v3AutoTrade.js
 *
 * Autonomous-entry runner for ONE user on the V3 engine. Reuses the EXISTING V3
 * pipeline with NO change to its gates: scanForexPairs() (the legacy waterfall +
 * V3 scoring) produces qualified signals, and each is routed through executeTrade()
 * — which enforces FOREX_AUTO_TRADE_ENABLED, the live-execution acknowledgement,
 * score/confidence/news/spread/duplicate-lock checks, and dynamic sizing.
 *
 * This is the V3 counterpart to ictAutoTrade.runAutoAiForUser. It is only reached
 * when the user's Auto AI Engine is 'v3'.
 */

import { scanForexPairs } from './oandaScanner.js';
import { executeTrade } from './oandaTrade.js';

function maskAccount(id) {
  return id && id.length > 4 ? `${id.slice(0, 3)}…${id.slice(-3)}` : '***';
}

function pairOf(item) {
  return item?.pair || item?.instrument || item?.symbol || item?.signal?.pair || null;
}

function textOf(item) {
  try { return JSON.stringify(item || {}).toLowerCase(); }
  catch { return String(item || '').toLowerCase(); }
}

function buildV3WatchState(scan, qualified = []) {
  const nearQualifiedPairs = new Set();
  const hotPairs = new Set();
  const lateEntryPairs = new Set();

  for (const sig of qualified) {
    const pair = pairOf(sig);
    if (pair) hotPairs.add(pair);
  }

  const rejected = Array.isArray(scan?.rejected) ? scan.rejected
    : Array.isArray(scan?.rejections) ? scan.rejections
    : Array.isArray(scan?.signals) ? scan.signals
    : [];

  for (const item of rejected) {
    const pair = pairOf(item);
    if (!pair) continue;

    const text = textOf(item);
    const confidence = Number(item?.confidence ?? item?.score ?? item?.v3?.score ?? 0);

    if (text.includes('late_entry') || text.includes('overextended')) {
      lateEntryPairs.add(pair);
      continue;
    }

    if (
      confidence >= 70 ||
      text.includes('near') ||
      text.includes('valid_entry') ||
      text.includes('liquidity_sweep') ||
      text.includes('fvg') ||
      text.includes('order block') ||
      text.includes('order_block')
    ) {
      nearQualifiedPairs.add(pair);
    }
  }

  for (const pair of lateEntryPairs) {
    nearQualifiedPairs.delete(pair);
    hotPairs.delete(pair);
  }

  return {
    nearQualifiedPairs: Array.from(nearQualifiedPairs),
    hotPairs: Array.from(hotPairs),
    lateEntryPairs: Array.from(lateEntryPairs),
  };
}

export async function runAutoV3ForUser({ client, now = new Date(), runId = null, scanMode = 'full', pairs = null } = {}) {
  const tag = `[AUTO_AI][V3][runId=${runId ?? '-'}]`;
  const account = maskAccount(client?.accountId);
  const log = (m) => console.log(`${tag} account=${account} engine=v3 ${m}`);
  void now;
  const scanPairs = Array.isArray(pairs) && pairs.length ? pairs : null;
  log(`scan started scanMode=${scanMode} pairs=${scanPairs?.length ? scanPairs.join(',') : 'ALL'}`);

  const scan = await scanForexPairs(scanPairs, { client, scanMode });
  const qualified = scan?.qualified ?? [];
  const watchState = buildV3WatchState(scan, qualified);

  if (!qualified.length) {
    log('scan complete qualified=0 executed=0 skipped=0');
    return { engine: 'v3', scanned: scan?.meta?.pairsScanned ?? 0, qualified: 0, executed: [], skipped: [], ...watchState };
  }

  const executed = [];
  const skipped = [];
  for (const sig of qualified) {
    // executeTrade reads signal.environment for its live-execution guard; align it
    // with the per-request client (the /auto endpoint requires environment=live).
    sig.environment = client?.environment || sig.environment;
    const res = await executeTrade(sig, { client, autoAi: true });
    if (res?.success) {
      executed.push({ pair: sig.pair, direction: sig.direction, tradeId: res.tradeId });
      log(`trade executed pair=${sig.pair} dir=${sig.direction} id=${res.tradeId}`);
    } else {
      skipped.push({ pair: sig.pair, reason: res?.reason || res?.rejectReason || 'not executed' });
      log(`execution skipped pair=${sig.pair} reason="${res?.reason || res?.rejectReason || 'not executed'}"`);
    }
  }
  log(`scan complete qualified=${qualified.length} executed=${executed.length} skipped=${skipped.length}`);
  return { engine: 'v3', scanned: scan?.meta?.pairsScanned ?? qualified.length, qualified: qualified.length, executed, skipped, ...watchState };
}
