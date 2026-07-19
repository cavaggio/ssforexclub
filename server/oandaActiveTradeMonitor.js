/**
 * server/oandaActiveTradeMonitor.js
 *
 * Re-runs the macro / structure / momentum / alignment waterfall against
 * currently-open OANDA trades and emits a per-trade state + exit recommendation.
 *
 *   GET /api/oanda/active-trades/analysis  →  { trades: [...], meta: {...} }
 *
 * READ-ONLY. Does not place orders or close positions. The frontend renders the
 * recommendation; any close is initiated manually via /api/oanda/close.
 */

import { getCandles, getPricing, getOpenTrades, getForexSession } from './oandaMarketData.js';
import {
  analyzeMacro, analyzeStructure, analyzeMomentum,
  computeAlignment, computeConfidenceScore,
} from './oandaMtfAnalysis.js';
import {
  computeHoldWindow, computeTradeProbabilities, classifyTradeState,
} from './oandaTradeLifecycle.js';
import { findTradeByBrokerOrderId } from './oandaTradeHistory.js';
import { computeLiveV3TpHitConfidence, isPureV3TradeRecord } from './v3TpConfidence.js';
import { analyzeV3OpenTrade } from './v3ActiveTradeMonitor.js';

function getPipSize(pair) {
  if (pair.includes('JPY'))                      return 0.01;
  if (pair === 'XAU_USD' || pair === 'XAG_USD')  return 0.01;
  return 0.0001;
}

function maxSpreadFor(pair) {
  if (pair === 'EUR_USD') return 3;
  if (pair === 'GBP_USD') return 4;
  if (pair === 'AUD_USD') return 5;
  if (pair === 'USD_JPY') return 5;
  if (pair === 'NZD_USD') return 6;
  if (pair === 'USD_CAD') return 6;
  if (pair.includes('JPY')) return 12;
  if (pair.includes('GBP')) return 8;
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return 50;
  return 6;
}

/**
 * Run the full re-assessment for an OANDA open-trade record.
 *
 * `oandaTrade` shape (from /v3/accounts/{id}/trades?state=OPEN):
 *   { id, instrument, currentUnits, price, openTime, unrealizedPL,
 *     stopLossOrder: { price }, takeProfitOrder: { price } }
 */
async function analyzeOneTrade(oandaTrade, session, { client } = {}) {
  const pair = oandaTrade.instrument;
  const units = parseFloat(oandaTrade.currentUnits);
  const side = units >= 0 ? 'long' : 'short';
  const entryPrice = parseFloat(oandaTrade.price);
  // OANDA returns openTime as either ISO ("2026-05-22T13:00:00Z") or a Unix
  // epoch seconds string ("1779584400.000000000"). Handle both.
  let openTimeMs = NaN;
  if (typeof oandaTrade.openTime === 'string') {
    const numeric = Number(oandaTrade.openTime);
    openTimeMs = Number.isFinite(numeric) && numeric > 1e9 && numeric < 1e11
      ? numeric * 1000
      : Date.parse(oandaTrade.openTime);
  }
  const minutesElapsed = Number.isFinite(openTimeMs)
    ? Math.max(0, Math.round((Date.now() - openTimeMs) / 60000))
    : 0;

  const stopLoss = oandaTrade.stopLossOrder
    ? parseFloat(oandaTrade.stopLossOrder.price)
    : null;
  const takeProfit = oandaTrade.takeProfitOrder
    ? parseFloat(oandaTrade.takeProfitOrder.price)
    : null;

  const historyRecord = findTradeByBrokerOrderId(String(oandaTrade.id));
  if (isPureV3TradeRecord(historyRecord || {})) {
    return analyzeV3OpenTrade(oandaTrade, { client, historyRecord, now: new Date() });
  }

  // Live mid price for the instrument
  const pricing = (await getPricing([pair], { client }))[0];
  const currentPrice = pricing ? pricing.mid : entryPrice;

  // Fresh candles for the waterfall
  const [dailyCandles, h4Candles, h1Candles, m30Candles, m15Candles, m5Candles] = await Promise.all([
    getCandles(pair, 'D',   60,  { client }).catch(() => []),
    getCandles(pair, 'H4',  60,  { client }).catch(() => []),
    getCandles(pair, 'H1',  80,  { client }).catch(() => []),
    getCandles(pair, 'M30', 96,  { client }).catch(() => []),
    getCandles(pair, 'M15', 120, { client }).catch(() => []),
    getCandles(pair, 'M5',  120, { client }).catch(() => []),
  ]);

  const macro     = analyzeMacro({ dailyCandles, h4Candles, pair });
  const structure = analyzeStructure({ h1Candles, m30Candles, macro, pair });
  const momentum  = analyzeMomentum({
    m15Candles, m5Candles,
    macroBias: macro.macroBias,
    structure, pair,
    spreadPips: pricing?.spreadPips,
    maxSpreadPips: maxSpreadFor(pair),
  });
  const alignment = computeAlignment({ macro, structure, momentum });
  const legacyCurrentConfidence = computeConfidenceScore({
    macro, structure, momentum, alignment,
    spreadPips: pricing?.spreadPips,
    maxSpreadPips: maxSpreadFor(pair),
    session,
    newsRisk: 'none',
  });

  // Updated hold window: TP distance from CURRENT price
  const pipSize = getPipSize(pair);
  const distanceToTPpips = takeProfit != null
    ? Math.max(0, (side === 'long' ? takeProfit - currentPrice : currentPrice - takeProfit) / pipSize)
    : 0;
  const updatedHoldWindow = takeProfit != null
    ? computeHoldWindow({
        takeProfitPips: distanceToTPpips,
        m15Candles, session, momentum, macro,
      })
    : { minMinutes: 0, maxMinutes: 0, holdConfidence: 0 };

  // Trade state + exit recommendation
  const classification = classifyTradeState({
    pair, side,
    entryPrice, currentPrice,
    stopLoss: stopLoss ?? (side === 'long' ? entryPrice * 0.99 : entryPrice * 1.01),
    takeProfit: takeProfit ?? (side === 'long' ? entryPrice * 1.01 : entryPrice * 0.99),
    currentWaterfall: { macro, structure, momentum, alignment },
    minutesElapsed,
    holdWindow: updatedHoldWindow,
  });


  const pureV3Trade = false; // V3 trades returned before foreign analysis
  const tradeSign = side === 'long' ? 'bullish' : 'bearish';
  const macroBias = String(macro?.macroBias || macro?.h4Trend || '').toLowerCase();
  const macroOpposes = Boolean(macroBias && macroBias !== 'neutral' && !macroBias.includes(tradeSign));
  const m15Trend = String(momentum?.m15Trend || momentum?.trend || '').toLowerCase();
  const m15TrendReversed =
    (side === 'long' && m15Trend === 'bearish') ||
    (side === 'short' && m15Trend === 'bullish');

  const liveV3Confidence = pureV3Trade
    ? computeLiveV3TpHitConfidence({
        side,
        entryPrice,
        currentPrice,
        stopLoss,
        takeProfit,
        entryTpHitConfidence: historyRecord?.entryTpHitConfidence,
        historyRecord,
        tpProgress: classification.tpProgress,
        entryAlignmentScore: historyRecord?.entryMtfAlignmentScore,
        currentAlignmentScore: alignment.timeframeAlignmentScore,
        mtfConflict: alignment.conflicting === true || alignment.conflict === true,
        macroOpposes,
        m15TrendReversed,
      })
    : null;
  const currentConfidence = liveV3Confidence?.tpHitConfidence ?? legacyCurrentConfidence;

  // Live probabilities given current alignment + R:R-to-go
  const remainingRR = (stopLoss != null && takeProfit != null && currentPrice !== entryPrice)
    ? Math.abs((takeProfit - currentPrice) / (currentPrice - stopLoss))
    : 1.5;
  const probs = computeTradeProbabilities({
    alignment, macro, structure, momentum, riskReward: remainingRR,
  });

  return {
    tradeId: String(oandaTrade.id),
    instrument: pair,
    side,
    units: Math.abs(units),
    entryPrice: +entryPrice.toFixed(5),
    currentPrice: +currentPrice.toFixed(5),
    openTime: oandaTrade.openTime,
    minutesElapsed,
    unrealizedPL: parseFloat(oandaTrade.unrealizedPL || 0),
    unrealizedPips: classification.unrealizedPips,
    stopLoss,
    takeProfit,
    distanceToTPPips: classification.distanceToTPPips,
    distanceToSLPips: classification.distanceToSLPips,
    tpProgress: classification.tpProgress,
    currentAlignmentScore: alignment.timeframeAlignmentScore,
    currentConfidence,
    tradeState: pureV3Trade ? liveV3Confidence.state : classification.tradeState,
    exitRecommendation: pureV3Trade ? liveV3Confidence.exitRecommendation : classification.exitRecommendation,
    exitReason: pureV3Trade
      ? `V3 live TP-hit confidence ${liveV3Confidence.tpHitConfidence}% (${liveV3Confidence.state})`
      : classification.exitReason,
    timeDecayRisk: classification.timeDecayRisk,
    updatedHoldWindow: {
      minMinutes: updatedHoldWindow.minMinutes,
      maxMinutes: updatedHoldWindow.maxMinutes,
      holdConfidence: updatedHoldWindow.holdConfidence,
    },
    tpProbability: pureV3Trade ? liveV3Confidence.tpProbability : probs.tpProbability,
    slProbability: pureV3Trade ? liveV3Confidence.slProbability : probs.slProbability,
    confidenceModel: pureV3Trade ? 'v3_live_tp_hit' : 'legacy_mtf',
    entryTpHitConfidence: historyRecord?.entryTpHitConfidence ?? null,
    entryQualityConfidence: historyRecord?.entryQualityConfidence ?? null,
    liveTpConfidence: liveV3Confidence,
    macroOpposes: classification.macroOpposes,
    conflictingTfCount: classification.conflictingTfCount,
    alignmentDropped: classification.alignmentDropped,
    waterfall: { macro, structure, momentum, alignment },
  };
}

/**
 * @param {Object} [options]
 * @param {Object} [options.client] per-request OANDA client. When provided,
 *   all market-data calls and the open-trades fetch go through it. Internal
 *   /api/internal/oanda/active-trades/analysis endpoint MUST pass this so
 *   user A's scan never touches user B's broker account.
 */
export async function analyzeActiveTrades(options = {}) {
  const { client } = options;
  const session = getForexSession();
  const openTrades = await getOpenTrades({ client });

  if (!openTrades.length) {
    return {
      trades: [],
      meta: {
        scannedAt: new Date().toISOString(),
        session,
        totalActive: 0,
        notice: 'No open positions on OANDA account',
      },
    };
  }

  const results = await Promise.all(
    openTrades.map(t => analyzeOneTrade(t, session, { client }).catch(err => ({
      tradeId: String(t.id),
      instrument: t.instrument,
      error: err?.message || String(err),
    }))),
  );

  const stateCounts = results.reduce((acc, r) => {
    if (r.tradeState) acc[r.tradeState] = (acc[r.tradeState] || 0) + 1;
    return acc;
  }, {});

  return {
    trades: results,
    meta: {
      scannedAt: new Date().toISOString(),
      session,
      totalActive: results.length,
      stateCounts,
      autoCloseEnabled: false,            // explicit: recommendations only
    },
  };
}
