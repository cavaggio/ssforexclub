import { getCandles, getPricing } from './oandaMarketData.js';
import { atr, emaAlignment } from './oandaIndicators.js';
import { evaluateV3 } from './v3Engine.js';
import { evaluateV3SetupStage, evaluateV3TriggerStage } from './v3QualityConfirmation.js';
import { computeV3EntryTpHitConfidence } from './v3TpConfidence.js';
import { scalpMinConfidence } from './scalpOnlyPolicy.js';
import { getForexNewsRisk } from './oandaNewsRisk.js';
import { analyzeRecentCandleStrength } from './oandaCandleStrength.js';
import { classifyV3NativeEntryTiming } from './v3NativeEntryTiming.js';
import { classifyV3WatchTier } from './v3WatchClassification.js';
import {
  evaluateV3PrimaryAlignmentFromCandles,
  trendFromCandles,
  V3_PRIMARY_ALIGNMENT_MIN_SCORE,
} from './v3PrimaryAlignment.js';

export const DEFAULT_V3_FOREX_WATCHLIST = [
  'EUR_USD',
  'GBP_USD',
  'USD_JPY',
  'USD_CAD',
  'USD_CHF',
  'AUD_USD',
  'NZD_USD',
  'EUR_GBP',
  'EUR_CHF',
  'AUD_CAD',
  'GBP_JPY',
  'EUR_JPY',
];

function envNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function uniquePairs(values = []) {
  return [...new Set(values
    .map((value) => String(value || '').trim().toUpperCase().replace('/', '_'))
    .filter((value) => /^[A-Z]{3}_[A-Z]{3}$/.test(value))
    .filter((value) => value !== 'XAU_USD' && value !== 'XAG_USD'))];
}

export function getConfiguredV3Watchlist(env = process.env) {
  const configured = String(env.V3_FOREX_WATCHLIST || env.FOREX_WATCHLIST || '')
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean);
  const resolved = uniquePairs(configured.length > 0 ? configured : DEFAULT_V3_FOREX_WATCHLIST);
  return resolved.length > 0 ? resolved : [...DEFAULT_V3_FOREX_WATCHLIST];
}

/** Full scans always evaluate the complete configured V3 watchlist. */
export function resolveV3ScanPairs({ scanMode = 'full', pairs = null, env = process.env } = {}) {
  const watchlist = getConfiguredV3Watchlist(env);
  if (String(scanMode).toLowerCase() === 'full') return watchlist;

  const requested = uniquePairs(Array.isArray(pairs) ? pairs : []);
  if (requested.length === 0) return watchlist;
  const allowed = new Set(watchlist);
  return requested.filter((pair) => allowed.has(pair));
}

function pipSize(pair = '') {
  return String(pair).includes('JPY') ? 0.01 : 0.0001;
}

function roundPrice(price, pair = '') {
  if (!Number.isFinite(price)) return null;
  return Number(price.toFixed(String(pair).includes('JPY') ? 3 : 5));
}

function firstFinite(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function chooseTarget(v3 = {}, direction, entry, stopPips, minimumRR) {
  const targets = [v3?.targets?.tp1, v3?.targets?.tp2, v3?.targets?.tp3].filter(Boolean);
  for (const target of targets) {
    const price = Number(target?.price);
    const targetPips = Math.abs(Number(target?.pips));
    if (!Number.isFinite(price) || !Number.isFinite(targetPips)) continue;
    const correctSide = direction === 'long' ? price > entry : price < entry;
    if (!correctSide) continue;
    const rr = stopPips > 0 ? targetPips / stopPips : 0;
    if (rr >= minimumRR) return { ...target, price, pips: targetPips, rr };
  }
  return null;
}

function buildExecutableGeometry({ pair, direction, entry, v3, minimumRR }) {
  const stopPips = Math.abs(Number(v3?.slPipsEst));
  if (!pair || !direction || !Number.isFinite(entry) || !Number.isFinite(stopPips) || stopPips <= 0) {
    return null;
  }

  const target = chooseTarget(v3, direction, entry, stopPips, minimumRR);
  if (!target) return null;

  const stopLoss = direction === 'long'
    ? roundPrice(entry - stopPips * pipSize(pair), pair)
    : roundPrice(entry + stopPips * pipSize(pair), pair);
  const takeProfit = roundPrice(target.price, pair);
  const expectedRR = +(target.rr.toFixed(2));

  if (!Number.isFinite(stopLoss) || !Number.isFinite(takeProfit) || expectedRR < minimumRR) return null;

  return {
    entry,
    entryPrice: entry,
    currentPrice: entry,
    stopLoss,
    takeProfit,
    targetProfit: takeProfit,
    expectedRR,
    rr: expectedRR,
    stopLossPips: +stopPips.toFixed(1),
    takeProfitPips: +target.pips.toFixed(1),
    targetSource: target.source || v3?.targets?.targetSource || 'v3_liquidity',
    lifecycle: {
      allowed: true,
      sl: {
        stopLossPips: +stopPips.toFixed(1),
        stopLossPrice: stopLoss,
        invalidationReason: 'V3-native structure/liquidity invalidation stop',
      },
      tp: {
        allowed: true,
        takeProfitPips: +target.pips.toFixed(1),
        takeProfitPrice: takeProfit,
        targetReason: `V3-native target from ${target.source || 'liquidity'}`,
        targetSource: target.source || 'v3_liquidity',
      },
      source: 'v3_native_lifecycle',
    },
  };
}

function rejection(pair, reason, extra = {}) {
  return { pair, reason, rejectionReasons: [reason], ...extra };
}

export async function scanV3Watchlist({
  client,
  scanMode = 'full',
  pairs = null,
  now = new Date(),
  log = console.log,
} = {}) {
  if (!client) throw new Error('V3 native scanner requires a user-scoped OANDA client');

  const scanPairs = resolveV3ScanPairs({ scanMode, pairs });
  const minimumRR = envNumber(process.env.FOREX_MIN_EXECUTABLE_RR, 1.5);
  const maxSpreadPips = envNumber(process.env.FOREX_MAX_SPREAD_PIPS, 3.5);
  const qualified = [];
  const rejected = [];
  const watchCandidates = [];
  const hotWatchCandidates = [];
  const lateEntryPairs = [];

  log(`[V3_NATIVE_SCAN] mode=${scanMode} reviewing=${scanPairs.length} pairs=${scanPairs.join(',')}`);

  let pricingMap = {};
  try {
    const prices = await getPricing(scanPairs, { client });
    pricingMap = Object.fromEntries((prices || []).map((price) => [price.instrument, price]));
  } catch (error) {
    throw new Error(`V3 native pricing fetch failed: ${error.message}`);
  }

  for (const pair of scanPairs) {
    try {
      const pricing = pricingMap[pair];
      if (!pricing) {
        rejected.push(rejection(pair, 'V3 native scan rejected: no OANDA pricing returned.'));
        continue;
      }
      if (pricing.tradeable === false) {
        rejected.push(rejection(pair, 'V3 native scan rejected: instrument is not tradeable.'));
        continue;
      }
      if (!Number.isFinite(Number(pricing.mid))) {
        rejected.push(rejection(pair, 'V3 native scan rejected: executable midpoint price is missing.'));
        continue;
      }
      if (Number(pricing.spreadPips) > maxSpreadPips) {
        rejected.push(rejection(
          pair,
          `V3 native scan rejected: spread ${pricing.spreadPips}p > ${maxSpreadPips}p.`,
          { spreadPips: pricing.spreadPips },
        ));
        continue;
      }

      const [dailyCandles, h4Candles, h1Candles, m15Candles] = await Promise.all([
        getCandles(pair, 'D', 60, { client }).catch(() => []),
        getCandles(pair, 'H4', 60, { client }).catch(() => []),
        getCandles(pair, 'H1', 80, { client }).catch(() => []),
        getCandles(pair, 'M15', 120, { client }).catch(() => []),
      ]);

      if (dailyCandles.length < 30 || h4Candles.length < 50 || h1Candles.length < 30 || m15Candles.length < 60) {
        rejected.push(rejection(
          pair,
          `V3 native scan rejected: insufficient candles D=${dailyCandles.length}, H4=${h4Candles.length}, H1=${h1Candles.length}, M15=${m15Candles.length}.`,
        ));
        continue;
      }

      const atrRaw = atr(m15Candles, 14);
      const atrPips = Number.isFinite(atrRaw) ? +(atrRaw / pipSize(pair)).toFixed(2) : null;
      const m15Closes = m15Candles.map((candle) => Number(candle.close)).filter(Number.isFinite);
      const momentum = {
        m15Trend: trendFromCandles(m15Candles, 60),
        m15Alignment: m15Closes.length >= 50 ? emaAlignment(m15Closes) : 'mixed',
        executionSignal: null,
        executionConfidence: 0,
      };

      const v3 = evaluateV3({
        pair,
        legacyDirection: null,
        dailyCandles,
        h4Candles,
        h1Candles,
        m15Candles,
        currentPrice: Number(pricing.mid),
        atrPips,
        atrHistorical: null,
        momentum,
        now,
      });

      const direction = String(v3?.direction || '').toLowerCase();
      const normalizedDirection = direction === 'long' || direction === 'short' ? direction : null;
      const primaryTimeframeAlignment = evaluateV3PrimaryAlignmentFromCandles({
        direction: normalizedDirection,
        dailyCandles,
        h4Candles,
        m15Candles,
      });

      if (!primaryTimeframeAlignment.passed) {
        rejected.push(rejection(pair, primaryTimeframeAlignment.reason, {
          direction: normalizedDirection,
          v3,
          primaryTimeframeAlignment,
        }));
        log(`[V3_NATIVE_ALIGNMENT] pair=${pair} dir=${normalizedDirection || 'none'} score=${primaryTimeframeAlignment.score} action=reject`);
        continue;
      }

      log(
        `[V3_NATIVE_ALIGNMENT] pair=${pair} dir=${normalizedDirection} ` +
        `score=${primaryTimeframeAlignment.score} opposing=${primaryTimeframeAlignment.opposingTimeframes.join(',') || 'none'} action=pass`,
      );

      const geometry = buildExecutableGeometry({
        pair,
        direction: normalizedDirection,
        entry: Number(pricing.mid),
        v3,
        minimumRR,
      });
      if (!geometry) {
        rejected.push(rejection(pair, `V3 native scan rejected: no target provides at least ${minimumRR}R.`, {
          direction: normalizedDirection,
          v3,
          primaryTimeframeAlignment,
        }));
        continue;
      }

      const newsRisk = await getForexNewsRisk(pair).catch((error) => ({
        pair,
        enabled: true,
        blocked: false,
        riskLevel: 'low',
        reason: `news provider unavailable: ${error.message}`,
      }));
      const candleStrength = analyzeRecentCandleStrength({
        candles: m15Candles,
        direction: normalizedDirection,
        pair,
        atrPips,
        window: 3,
      });
      const entryTiming = classifyV3NativeEntryTiming({
        direction: normalizedDirection,
        fibonacci: v3?.fib,
        v3,
        m15Candles,
        atrPips,
        newsRisk,
        currentPrice: Number(pricing.mid),
        pair,
      });

      const rawV3Score = firstFinite(v3?.score) ?? 0;
      const entryQualityConfidence = Math.max(0, Math.min(100, Math.round(
        rawV3Score +
        (v3?.qualified === true ? 14 : 0) +
        (v3?.earlyTrigger === true ? 5 : 0) +
        (Number(v3?.premiumDiscount?.premiumDiscountScore) >= 0.75 ? 5 : 0) +
        (Number(v3?.liquidityIntent?.intentScore ?? v3?.liquidityIntent?.score) >= 0.65 ? 6 : 0)
      )));

      const candidateBase = {
        pair,
        direction: normalizedDirection,
        ...geometry,
        spreadPips: Number(pricing.spreadPips),
        bid: Number(pricing.bid),
        ask: Number(pricing.ask),
        confidence: entryQualityConfidence,
        entryQualityConfidence,
        v3Score: rawV3Score,
        v3,
        momentum: { ...momentum, executionSignal: normalizedDirection },
        candleStrength,
        newsRisk,
        entryTiming,
        entryStatus: entryTiming?.status || null,
        primaryTimeframeAlignment,
        alignment: {
          timeframeAlignmentScore: primaryTimeframeAlignment.score,
          tradeQualified: true,
          primaryConflictPolicy: 'diagnostic_only',
          primaryConflictingTimeframes: primaryTimeframeAlignment.opposingTimeframes,
        },
        source: 'v3_native_scanner',
        finalQualifiedStatus: 'v3_native_alignment_passed',
      };

      const tpHitConfidence = computeV3EntryTpHitConfidence(candidateBase);
      const candidate = {
        ...candidateBase,
        confidence: tpHitConfidence,
        tpHitConfidence,
      };
      const stage1 = evaluateV3SetupStage(candidate);
      // Evaluate Stage 2 even when Stage 1 is below threshold so V3 can distinguish
      // a genuine retest/trigger watch from an ordinary rejected setup. Execution
      // still requires BOTH stages to pass.
      const stage2 = evaluateV3TriggerStage(candidate);
      const qualityConfirmation = { stage1, stage2, checkedAt: new Date().toISOString() };
      const watchTier = classifyV3WatchTier({
        primaryAlignment: primaryTimeframeAlignment,
        geometryValid: true,
        newsBlocked: newsRisk?.blocked === true,
        spreadOk: Number(pricing.spreadPips) <= maxSpreadPips,
        entryTiming,
        stage1,
        stage2,
      });

      log(
        `[V3_NATIVE_QUALITY] pair=${pair} timing=${entryTiming?.status || 'unknown'} ` +
        `stage1=${stage1.allowed ? 'pass' : 'fail'} stage2=${stage2.state} tier=${watchTier.tier} ` +
        `reason="${watchTier.reason}"`,
      );

      if (watchTier.tier === 'hot') {
        hotWatchCandidates.push({
          ...candidate,
          qualityConfirmation,
          watchTier,
          finalQualifiedStatus: 'v3_native_hot_watch',
        });
        continue;
      }

      if (watchTier.tier === 'near') {
        watchCandidates.push({
          ...candidate,
          qualityConfirmation,
          watchTier,
          finalQualifiedStatus: 'v3_native_near_watch',
        });
        continue;
      }

      const ready = watchTier.tier === 'ready'
        && stage1.allowed
        && stage2.allowed
        && entryTiming?.status === 'valid_entry'
        && primaryTimeframeAlignment.score >= V3_PRIMARY_ALIGNMENT_MIN_SCORE
        && Number.isFinite(tpHitConfidence)
        && tpHitConfidence >= scalpMinConfidence();

      if (!ready) {
        const reasons = [
          ...stage1.reasons,
          ...stage2.reasons,
          entryTiming?.reason ? `entry timing: ${entryTiming.reason}` : null,
          watchTier.reason,
        ].filter(Boolean);
        if (entryTiming?.status === 'late_entry') lateEntryPairs.push(pair);
        rejected.push(rejection(
          pair,
          `V3 native quality rejected: ${reasons.join('; ') || `TP-hit confidence ${tpHitConfidence} below ${scalpMinConfidence()}`}`,
          { direction: normalizedDirection, v3, primaryTimeframeAlignment, entryTiming, qualityConfirmation, watchTier },
        ));
        continue;
      }

      qualified.push({
        ...candidate,
        qualityConfirmation,
        watchTier,
        finalQualifiedStatus: 'v3_native_quality_confirmed',
      });
    } catch (error) {
      rejected.push(rejection(pair, `V3 native scan error: ${error.message}`));
      log(`[V3_NATIVE_SCAN_ERROR] pair=${pair} error=${error.message}`);
    }
  }

  return {
    engine: 'v3_native',
    scanMode,
    pairs: scanPairs,
    scanned: scanPairs.length,
    qualified,
    rejected,
    watchCandidates,
    hotWatchCandidates,
    nearQualifiedPairs: [...new Set(watchCandidates.map((item) => item.pair).filter(Boolean))],
    hotPairs: [...new Set([
      ...hotWatchCandidates.map((item) => item.pair),
      ...qualified.map((item) => item.pair),
    ].filter(Boolean))],
    lateEntryPairs: [...new Set(lateEntryPairs)],
    meta: {
      primaryAlignmentMinimum: V3_PRIMARY_ALIGNMENT_MIN_SCORE,
      configuredWatchlistSize: getConfiguredV3Watchlist().length,
      requestedPairCount: Array.isArray(pairs) ? pairs.length : 0,
      nearWatchCount: watchCandidates.length,
      hotWatchCount: hotWatchCandidates.length,
    },
  };
}
