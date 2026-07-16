import { getCandles, getPricing, getForexSession } from './oandaMarketData.js';
import { atr } from './oandaIndicators.js';
import { evaluateV3 } from './v3Engine.js';
import { getForexNewsRisk } from './oandaNewsRisk.js';
import { evaluateV3SetupStage, evaluateV3TriggerStage } from './v3QualityConfirmation.js';
import { computeV3EntryTpHitConfidence } from './v3TpConfidence.js';

const DEFAULT_V3_WATCHLIST = [
  'EUR_USD',
  'USD_CAD',
  'AUD_USD',
  'NZD_USD',
  'USD_CHF',
  'EUR_GBP',
  'EUR_CHF',
  'AUD_CAD',
];

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function configuredWatchlist() {
  const raw = process.env.FOREX_V3_WATCHLIST || process.env.FOREX_WATCHLIST || '';
  if (!raw.trim()) return DEFAULT_V3_WATCHLIST;
  return [...new Set(raw.split(',').map((pair) => pair.trim().toUpperCase()).filter(Boolean))];
}

function normalizeDirection(value) {
  const direction = String(value || '').toLowerCase();
  if (direction === 'buy') return 'long';
  if (direction === 'sell') return 'short';
  return direction === 'long' || direction === 'short' ? direction : null;
}

function pipSizeFor(pair = '') {
  if (String(pair).includes('JPY')) return 0.01;
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return 0.01;
  return 0.0001;
}

function priceDecimalsFor(pair = '') {
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return 2;
  return String(pair).includes('JPY') ? 3 : 5;
}

function roundPrice(price, pair) {
  return Number.isFinite(price) ? Number(price.toFixed(priceDecimalsFor(pair))) : null;
}

function maxSpreadFor(pair = '') {
  return pair === 'XAU_USD' || pair === 'XAG_USD'
    ? envNumber('METALS_MAX_SPREAD_PIPS', 50)
    : envNumber('FOREX_MAX_SPREAD_PIPS', 3.5);
}

function validTargetForDirection(target, direction, entry) {
  const price = Number(target?.price);
  if (!Number.isFinite(price) || !Number.isFinite(entry)) return false;
  return direction === 'long' ? price > entry : price < entry;
}

function pickV3Target(v3 = {}, direction, entry, minRR) {
  const stopPips = Math.abs(Number(v3?.slPipsEst));
  if (!Number.isFinite(stopPips) || stopPips <= 0) return null;

  const targets = [v3?.targets?.tp1, v3?.targets?.tp2, v3?.targets?.tp3].filter(Boolean);
  return targets.find((target) => {
    const rewardPips = Math.abs(Number(target?.pips));
    return (
      Number.isFinite(rewardPips) &&
      rewardPips / stopPips >= minRR &&
      validTargetForDirection(target, direction, entry)
    );
  }) || null;
}

export function computeV3OnlyEntryQualityConfidence(v3 = {}) {
  const score = Number(v3?.score);
  if (!Number.isFinite(score)) return null;

  let confidence = score;
  if (v3?.qualified === true) confidence += 14;
  if (v3?.earlyTrigger === true) confidence += 5;
  if (Number(v3?.premiumDiscount?.premiumDiscountScore) >= 0.75) confidence += 5;
  if (Number(v3?.liquidityIntent?.intentScore ?? v3?.liquidityIntent?.score) >= 0.65) confidence += 6;

  return Math.max(0, Math.min(100, Math.round(confidence)));
}

/**
 * Build an executable candidate exclusively from V3 output and current OANDA
 * pricing. No legacy scanner candidate, direction, confidence, lifecycle, or
 * rejection state is accepted as an input.
 */
export function buildIndependentV3Candidate({
  pair,
  pricing,
  v3,
  newsRisk = null,
  session = null,
  minRR = envNumber('FOREX_MIN_EXECUTABLE_RR', 1.5),
} = {}) {
  const direction = normalizeDirection(v3?.direction);
  const entry = Number(pricing?.mid);
  const spreadPips = Number(pricing?.spreadPips);
  const stopLossPips = Math.abs(Number(v3?.slPipsEst));

  if (!pair || !direction || !Number.isFinite(entry) || !Number.isFinite(stopLossPips) || stopLossPips <= 0) {
    return null;
  }

  const target = pickV3Target(v3, direction, entry, minRR);
  if (!target) return null;

  const pipSize = pipSizeFor(pair);
  const stopLoss = roundPrice(
    direction === 'long'
      ? entry - stopLossPips * pipSize
      : entry + stopLossPips * pipSize,
    pair,
  );
  const takeProfit = roundPrice(Number(target.price), pair);
  const takeProfitPips = Math.abs(Number(target.pips));
  const expectedRR = Number((takeProfitPips / stopLossPips).toFixed(2));

  if (
    !Number.isFinite(stopLoss) ||
    !Number.isFinite(takeProfit) ||
    expectedRR < minRR ||
    (direction === 'long' && !(stopLoss < entry && takeProfit > entry)) ||
    (direction === 'short' && !(stopLoss > entry && takeProfit < entry))
  ) {
    return null;
  }

  const entryQualityConfidence = computeV3OnlyEntryQualityConfidence(v3);
  const candidate = {
    pair,
    direction,
    score: Number(v3.score),
    confidence: entryQualityConfidence,
    entryQualityConfidence,
    entry,
    entryPrice: entry,
    currentPrice: entry,
    stopLoss,
    takeProfit,
    targetProfit: takeProfit,
    stopLossPips: Number(stopLossPips.toFixed(1)),
    takeProfitPips: Number(takeProfitPips.toFixed(1)),
    expectedRR,
    rr: expectedRR,
    spreadPips,
    maxSpreadPips: maxSpreadFor(pair),
    session,
    newsRisk,
    v3,
    engine: 'v3',
    strategy: 'V3',
    selectedLogicType: 'v3_pure',
    source: 'v3_independent_raw_market_data',
    architecture: 'independent_v3_raw_market_data',
    legacyScannerUsed: false,
    legacyDirection: null,
    lifecycle: {
      allowed: true,
      source: 'v3_independent_lifecycle',
      sl: {
        stopLossPips: Number(stopLossPips.toFixed(1)),
        stopLossPrice: stopLoss,
        invalidationReason: 'V3-native liquidity/structure invalidation stop',
      },
      tp: {
        allowed: true,
        takeProfitPips: Number(takeProfitPips.toFixed(1)),
        takeProfitPrice: takeProfit,
        targetReason: `V3-native target from ${target.source || 'liquidity'}`,
        targetSource: target.source || v3?.targets?.targetSource || 'v3_liquidity',
      },
    },
  };

  const tpHitConfidence = computeV3EntryTpHitConfidence(candidate);
  candidate.tpHitConfidence = tpHitConfidence;
  candidate.confidence = tpHitConfidence;
  candidate.tpProbability = Number((tpHitConfidence / 100).toFixed(3));
  candidate.slProbability = Number((1 - candidate.tpProbability).toFixed(3));

  return candidate;
}

function rejectionRecord({ pair, reason, reasons = [], pricing = null, v3 = null, candidate = null } = {}) {
  return {
    ...(candidate || {}),
    pair,
    reason,
    rejectionReasons: reasons.length ? reasons : [reason],
    spreadPips: pricing?.spreadPips ?? candidate?.spreadPips ?? null,
    currentPrice: pricing?.mid ?? candidate?.currentPrice ?? null,
    v3,
    engine: 'v3',
    source: 'v3_independent_raw_market_data',
    architecture: 'independent_v3_raw_market_data',
    legacyScannerUsed: false,
    legacyDirection: null,
  };
}

export async function scanV3IndependentMarket({
  pairs = null,
  client,
  now = new Date(),
  scanMode = 'full',
  log = () => {},
} = {}) {
  const watchlist = [...new Set((Array.isArray(pairs) && pairs.length ? pairs : configuredWatchlist()).map((pair) => String(pair).toUpperCase()))];
  const session = getForexSession();
  const qualified = [];
  const rejected = [];
  const watchCandidates = [];
  const v3ByPair = {};

  let pricingMap = {};
  try {
    const pricing = await getPricing(watchlist, { client });
    pricingMap = Object.fromEntries(pricing.map((item) => [item.instrument, item]));
  } catch (error) {
    throw new Error(`Independent V3 pricing fetch failed: ${error.message}`);
  }

  for (const pair of watchlist) {
    const pricing = pricingMap[pair];
    if (!pricing) {
      rejected.push(rejectionRecord({ pair, reason: 'Independent V3: no pricing returned' }));
      continue;
    }
    if (pricing.tradeable === false) {
      rejected.push(rejectionRecord({ pair, pricing, reason: 'Independent V3: instrument is not tradeable' }));
      continue;
    }

    const maxSpreadPips = maxSpreadFor(pair);
    if (Number(pricing.spreadPips) > maxSpreadPips) {
      rejected.push(rejectionRecord({
        pair,
        pricing,
        reason: `Independent V3: spread ${pricing.spreadPips} > ${maxSpreadPips}`,
      }));
      continue;
    }

    try {
      const [dailyCandles, h4Candles, h1Candles, m15Candles] = await Promise.all([
        getCandles(pair, 'D', 60, { client }).catch(() => []),
        getCandles(pair, 'H4', 80, { client }).catch(() => []),
        getCandles(pair, 'H1', 80, { client }).catch(() => []),
        getCandles(pair, 'M15', 120, { client }).catch(() => []),
      ]);

      const missing = [];
      if (dailyCandles.length < 30) missing.push(`D=${dailyCandles.length}`);
      if (h4Candles.length < 50) missing.push(`H4=${h4Candles.length}`);
      if (h1Candles.length < 50) missing.push(`H1=${h1Candles.length}`);
      if (m15Candles.length < 60) missing.push(`M15=${m15Candles.length}`);
      if (missing.length) {
        rejected.push(rejectionRecord({
          pair,
          pricing,
          reason: `Independent V3: insufficient raw candles (${missing.join(', ')})`,
        }));
        continue;
      }

      const pipSize = pipSizeFor(pair);
      const atrM15Raw = atr(m15Candles, 14);
      const atrH4Raw = atr(h4Candles, 14);
      const atrPips = Number.isFinite(atrM15Raw) ? Number((atrM15Raw / pipSize).toFixed(2)) : null;
      const atrHistorical = Number.isFinite(atrH4Raw) ? Number((atrH4Raw / pipSize).toFixed(2)) : null;

      const v3 = evaluateV3({
        pair,
        legacyDirection: null,
        dailyCandles,
        h4Candles,
        h1Candles,
        m15Candles,
        currentPrice: Number(pricing.mid),
        atrPips,
        atrHistorical,
        momentum: null,
        now,
      });
      v3ByPair[pair] = v3;

      const newsRisk = await getForexNewsRisk(pair).catch((error) => ({
        pair,
        enabled: true,
        blocked: false,
        riskLevel: 'low',
        reason: `news provider unavailable: ${error.message}`,
        provider: { source: null, warning: error.message },
      }));

      const candidate = buildIndependentV3Candidate({ pair, pricing, v3, newsRisk, session });
      if (!candidate) {
        const reasons = [
          ...(Array.isArray(v3?.rejectionReasons) ? v3.rejectionReasons : []),
          'Independent V3 could not build valid stop/target geometry of at least 1.5R',
        ];
        rejected.push(rejectionRecord({ pair, pricing, v3, reason: reasons[0], reasons }));
        continue;
      }

      const stage1 = evaluateV3SetupStage(candidate);
      const stage2 = stage1.allowed
        ? evaluateV3TriggerStage(candidate)
        : {
            stage: 2,
            allowed: false,
            state: 'blocked',
            reasons: ['stage 1 setup did not pass'],
            primaryTriggers: [],
            supports: [],
            checkedAt: new Date().toISOString(),
          };

      candidate.qualityConfirmation = {
        stage1,
        stage2,
        checkedAt: new Date().toISOString(),
      };

      const reasons = [
        ...(v3?.qualified === true ? [] : (v3?.rejectionReasons || ['V3-native qualification failed'])),
        ...stage1.reasons,
        ...stage2.reasons,
      ];

      if (v3?.qualified === true && stage1.allowed && stage2.allowed) {
        candidate.finalQualifiedStatus = 'v3_independent_quality_confirmed';
        qualified.push(candidate);
        log(
          `independent-ready pair=${pair} dir=${candidate.direction} score=${v3.score} ` +
          `tpConf=${candidate.tpHitConfidence} rr=${candidate.expectedRR} ` +
          `triggers=${stage2.primaryTriggers.join(',') || 'none'}`,
        );
      } else {
        const record = rejectionRecord({
          pair,
          pricing,
          v3,
          candidate,
          reason: reasons[0] || 'Independent V3 quality confirmation failed',
          reasons,
        });
        rejected.push(record);

        if (stage1.allowed && !stage2.allowed) {
          watchCandidates.push({
            ...record,
            state: stage2.state,
            primaryTriggers: stage2.primaryTriggers,
            supports: stage2.supports,
          });
        }
      }
    } catch (error) {
      rejected.push(rejectionRecord({
        pair,
        pricing,
        reason: `Independent V3 analysis failed: ${error.message}`,
      }));
      log(`independent-error pair=${pair} error="${error.message}"`);
    }
  }

  return {
    engine: 'v3',
    architecture: 'independent_v3_raw_market_data',
    legacyScannerUsed: false,
    scanMode,
    session,
    qualified,
    rejected,
    watchCandidates,
    v3ByPair,
    meta: {
      pairsRequested: watchlist.length,
      pairsScanned: watchlist.length,
      qualified: qualified.length,
      rejected: rejected.length,
      watchCandidates: watchCandidates.length,
      generatedAt: new Date().toISOString(),
    },
  };
}
