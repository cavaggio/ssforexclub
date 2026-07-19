import { getCandles, getPricing } from './oandaMarketData.js';
import { atr } from './oandaIndicators.js';
import { evaluateV3 } from './v3Engine.js';
import { computeLiveV3TpHitConfidence } from './v3TpConfidence.js';

function pipSizeFor(pair = '') {
  if (String(pair).includes('JPY')) return 0.01;
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return 0.01;
  return 0.0001;
}

function openTimeMs(value) {
  if (typeof value !== 'string') return NaN;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 1e9 && numeric < 1e11) return numeric * 1000;
  return Date.parse(value);
}

function progressMetrics({ side, entryPrice, currentPrice, stopLoss, takeProfit, pipSize }) {
  const profitPips = side === 'long'
    ? (currentPrice - entryPrice) / pipSize
    : (entryPrice - currentPrice) / pipSize;
  const originalRiskPips = Number.isFinite(stopLoss)
    ? Math.abs(entryPrice - stopLoss) / pipSize
    : null;
  const targetPips = Number.isFinite(takeProfit)
    ? Math.abs(takeProfit - entryPrice) / pipSize
    : null;
  const tpProgress = targetPips && profitPips > 0
    ? Math.max(0, Math.min(1, profitPips / targetPips))
    : 0;
  return {
    profitPips,
    profitR: originalRiskPips ? +(profitPips / originalRiskPips).toFixed(2) : null,
    tpProgress,
    distanceToTPPips: Number.isFinite(takeProfit)
      ? Math.max(0, side === 'long' ? (takeProfit - currentPrice) / pipSize : (currentPrice - takeProfit) / pipSize)
      : null,
    distanceToSLPips: Number.isFinite(stopLoss)
      ? Math.max(0, side === 'long' ? (currentPrice - stopLoss) / pipSize : (stopLoss - currentPrice) / pipSize)
      : null,
  };
}

/**
 * Reassess an open V3 trade using raw candles and V3-native state only.
 * No legacy MTF waterfall, ICT concept, PPR state, or foreign confidence model
 * is accepted as an input.
 */
export async function analyzeV3OpenTrade(oandaTrade, { client, historyRecord = null, now = new Date() } = {}) {
  const pair = oandaTrade.instrument;
  const units = Number(oandaTrade.currentUnits);
  const side = units >= 0 ? 'long' : 'short';
  const entryPrice = Number(oandaTrade.price);
  const stopLoss = oandaTrade.stopLossOrder ? Number(oandaTrade.stopLossOrder.price) : null;
  const takeProfit = oandaTrade.takeProfitOrder ? Number(oandaTrade.takeProfitOrder.price) : null;
  const pipSize = pipSizeFor(pair);

  const [pricingRows, dailyCandles, h4Candles, h1Candles, m15Candles] = await Promise.all([
    getPricing([pair], { client }),
    getCandles(pair, 'D', 60, { client }).catch(() => []),
    getCandles(pair, 'H4', 80, { client }).catch(() => []),
    getCandles(pair, 'H1', 80, { client }).catch(() => []),
    getCandles(pair, 'M15', 120, { client }).catch(() => []),
  ]);
  const pricing = pricingRows?.[0] || null;
  const currentPrice = Number(pricing?.mid ?? entryPrice);
  const atrM15 = atr(m15Candles, 14);
  const atrH4 = atr(h4Candles, 14);
  const atrPips = Number.isFinite(atrM15) ? atrM15 / pipSize : null;
  const atrHistorical = Number.isFinite(atrH4) ? atrH4 / pipSize : null;

  const v3 = evaluateV3({
    pair,
    dailyCandles,
    h4Candles,
    h1Candles,
    m15Candles,
    currentPrice,
    atrPips,
    atrHistorical,
    now,
  });

  const metrics = progressMetrics({ side, entryPrice, currentPrice, stopLoss, takeProfit, pipSize });
  const directionalConflict = Boolean(v3.direction && v3.direction !== side);
  const alignmentConflict = v3.primaryTimeframeAlignment?.passed !== true || directionalConflict;
  const expectedTrend = side === 'long' ? 'bullish' : 'bearish';
  const m15TrendReversed = Boolean(
    v3.timeframes?.m15 &&
    v3.timeframes.m15 !== 'neutral' &&
    v3.timeframes.m15 !== expectedTrend
  );
  const structureOpposes = Boolean(
    v3.structure?.structureTrend &&
    v3.structure.structureTrend !== 'ranging' &&
    v3.structure.structureTrend !== expectedTrend &&
    !(v3.structure?.chochDetected && v3.structure?.choch?.direction === expectedTrend)
  );
  const volatilityCollapsed = String(v3.volatility?.volatilityState || '').toLowerCase() === 'compressed';

  const live = computeLiveV3TpHitConfidence({
    side,
    entryPrice,
    currentPrice,
    stopLoss,
    takeProfit,
    entryTpHitConfidence: historyRecord?.entryTpHitConfidence,
    historyRecord,
    profitR: metrics.profitR,
    tpProgress: metrics.tpProgress,
    currentAlignmentScore: v3.primaryTimeframeAlignment?.score,
    mtfConflict: alignmentConflict,
    macroOpposes: directionalConflict,
    flowOpposes: structureOpposes,
    m15TrendReversed,
    volatilityCollapsed,
    invalidationDetected: directionalConflict && structureOpposes,
    trendWeakeningDetected: m15TrendReversed || volatilityCollapsed,
    trendWeakeningSeverity: directionalConflict ? 'high' : 'medium',
  });

  const openedAt = openTimeMs(oandaTrade.openTime);
  const minutesElapsed = Number.isFinite(openedAt)
    ? Math.max(0, Math.round((now.getTime() - openedAt) / 60000))
    : 0;

  return {
    tradeId: String(oandaTrade.id),
    instrument: pair,
    side,
    direction: side,
    units: Math.abs(units),
    entryPrice,
    currentPrice,
    stopLoss,
    takeProfit,
    openTime: oandaTrade.openTime,
    minutesElapsed,
    unrealizedPL: Number(oandaTrade.unrealizedPL || 0),
    unrealizedPips: +metrics.profitPips.toFixed(1),
    profitRMultiple: metrics.profitR,
    distanceToTPPips: metrics.distanceToTPPips,
    distanceToSLPips: metrics.distanceToSLPips,
    tpProgress: +metrics.tpProgress.toFixed(3),
    currentAlignmentScore: v3.primaryTimeframeAlignment?.score ?? 0,
    currentConfidence: live.tpHitConfidence,
    tradeState: live.state,
    exitRecommendation: live.exitRecommendation,
    exitReason: `V3-native live TP-hit confidence ${live.tpHitConfidence}% (${live.state})`,
    tpProbability: live.tpProbability,
    slProbability: live.slProbability,
    confidenceModel: 'v3_native_live_tp_hit',
    entryTpHitConfidence: historyRecord?.entryTpHitConfidence ?? null,
    entryQualityConfidence: historyRecord?.entryQualityConfidence ?? null,
    liveTpConfidence: live,
    engine: 'v3',
    architecture: 'independent_v3_raw_market_data',
    strategyAnalysis: v3,
    directionalConflict,
    alignmentConflict,
    m15TrendReversed,
    volatilityCollapsed,
  };
}

export async function reassessV3OpenTrade(oandaTrade, options = {}) {
  const analysis = await analyzeV3OpenTrade(oandaTrade, options);
  let recommendedAction = 'HOLD';
  const managementReasons = [analysis.exitReason];

  if (analysis.exitRecommendation === 'EXIT_NOW') recommendedAction = 'EXIT_INVALIDATED';
  else if (analysis.exitRecommendation === 'EXIT_REVIEW') recommendedAction = 'EXIT_REVIEW';
  else if ((analysis.profitRMultiple ?? 0) >= 1.5) recommendedAction = 'TRAIL_SL';
  else if ((analysis.profitRMultiple ?? 0) >= 1) recommendedAction = 'MOVE_SL_TO_BREAKEVEN';

  return {
    ...analysis,
    selectedLogicType: 'v3_pure',
    recommendedAction,
    managementReasons,
    recommendedStopLoss: null,
    recommendedTakeProfit: analysis.takeProfit,
    partialExitPercent: 0,
    invalidationDetected: analysis.directionalConflict && analysis.alignmentConflict,
    invalidationSeverity: analysis.directionalConflict ? 'high' : 'none',
    trendWeakeningDetected: analysis.m15TrendReversed || analysis.volatilityCollapsed,
    trendWeakeningSeverity: analysis.directionalConflict ? 'high' : 'medium',
    volatilityCollapsed: analysis.volatilityCollapsed,
    lastReassessedAt: new Date().toISOString(),
    lifecycleRecommendation: {
      action: recommendedAction,
      reasons: managementReasons,
      engine: 'v3',
    },
    detail: {
      engine: 'v3',
      strategyAnalysis: analysis.strategyAnalysis,
      liveTpConfidence: analysis.liveTpConfidence,
    },
  };
}
