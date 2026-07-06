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

function envOn(value, fallback = false) {
  const raw = value == null ? String(fallback) : String(value);
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function envNum(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeV3Direction(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'buy') return 'long';
  if (v === 'sell') return 'short';
  if (v === 'long' || v === 'short') return v;
  return null;
}

function safeV3Promotions(scan, log) {
  if (!envOn(process.env.FOREX_V3_PROMOTE_ONLY, false)) return [];

  const rejected = Array.isArray(scan?.rejected) ? scan.rejected : [];
  const minConfidence = envNum(process.env.FOREX_V3_PROMOTE_MIN_CONFIDENCE, 70);
  const minRR = envNum(process.env.FOREX_V3_PROMOTE_MIN_RR, 1.75);
  const promoted = [];

  for (const item of rejected) {
    const v3 = item?.v3 || item?.v3Eval || item?.v3Analysis || item?.metadata?.v3 || null;
    if (!v3) continue;

    const pair = item?.pair || v3?.pair;
    const direction = normalizeV3Direction(item?.direction || v3?.direction || v3?.signal);
    const confidence = envNum(item?.confidence ?? v3?.confidence ?? v3?.score, NaN);
    const rr = envNum(item?.expectedRR ?? item?.rr ?? v3?.expectedRR ?? v3?.rr, NaN);

    const entry = Number(item?.entry ?? item?.entryPrice ?? v3?.entry ?? v3?.entryPrice);
    const stopLoss = Number(item?.stopLoss ?? item?.sl ?? v3?.stopLoss ?? v3?.sl);
    const targetProfit = Number(item?.targetProfit ?? item?.takeProfit ?? item?.tp ?? v3?.targetProfit ?? v3?.takeProfit ?? v3?.tp);

    const news = item?.newsRisk || v3?.newsRisk || {};
    const entryStatus = item?.entryTiming?.status || v3?.entryTiming?.status || '';

    const text = [
      item?.reason,
      item?.rejectionReason,
      item?.finalQualifiedStatus,
      entryStatus,
      v3?.reason,
      v3?.rejectionReason,
    ].filter(Boolean).join(' ').toLowerCase();

    const safe =
      pair &&
      direction &&
      confidence >= minConfidence &&
      rr >= minRR &&
      Number.isFinite(entry) &&
      Number.isFinite(stopLoss) &&
      Number.isFinite(targetProfit) &&
      !news.blocked &&
      entryStatus !== 'late_entry' &&
      !text.includes('news_block') &&
      !text.includes('late_entry') &&
      !text.includes('overextended') &&
      !text.includes('spread') &&
      !text.includes('margin') &&
      !text.includes('drawdown') &&
      !text.includes('risk cap');

    if (!safe) {
      log(`v3-only not promoted pair=${pair || 'unknown'} conf=${Number.isFinite(confidence) ? confidence : 'n/a'} rr=${Number.isFinite(rr) ? rr : 'n/a'} reason="${text || 'missing safe execution fields'}"`);
      continue;
    }

    promoted.push({
      ...item,
      ...v3,
      pair,
      direction,
      confidence,
      expectedRR: rr,
      rr,
      entry,
      entryPrice: entry,
      stopLoss,
      targetProfit,
      takeProfit: targetProfit,
      source: 'v3_promoted_only',
      finalQualifiedStatus: 'v3_promoted_only',
    });

    log(`v3-only promoted pair=${pair} dir=${direction} conf=${confidence} rr=${rr}`);
  }

  return promoted;
}

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
  const legacyQualified = Array.isArray(scan?.qualified) ? scan.qualified : [];
  const promoted = safeV3Promotions(scan, log);
  const qualified = [...legacyQualified, ...promoted];
  const watchState = buildV3WatchState(scan, qualified);

  if (!qualified.length) {
    log('scan complete qualified=0 executed=0 skipped=0 v3Promoted=0');
    return { engine: 'v3', scanned: scan?.meta?.pairsScanned ?? 0, qualified: 0, executed: [], skipped: [], v3Promoted: 0, ...watchState };
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
  log(`scan complete qualified=${qualified.length} executed=${executed.length} skipped=${skipped.length} v3Promoted=${promoted.length}`);
  return { engine: 'v3', scanned: scan?.meta?.pairsScanned ?? qualified.length, qualified: qualified.length, executed, skipped, v3Promoted: promoted.length, ...watchState };
}
