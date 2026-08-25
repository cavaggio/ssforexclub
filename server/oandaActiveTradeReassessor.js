/**
 * server/oandaActiveTradeReassessor.js
 *
 * Active-trade management orchestrator. Re-runs the full waterfall against
 * each currently-open OANDA trade, layers the new management modules
 * (trailing / partials / TP-reduction / profit-protection / volatility
 * collapse / invalidation / trend weakening), folds in MFE giveback, and
 * emits the spec'd debug-response shape per trade.
 *
 *   reassessActiveTrades()                — main entry — Parts 1, 11
 *   startReassessmentScheduler({intervalMs}) — env-guarded 15-min loop — Part 10
 *   stopReassessmentScheduler()
 *
 * Safety (Part 12):
 *   - Returns RECOMMENDATIONS ONLY by default.
 *   - Live execution requires FOREX_ALLOW_LIVE_EXECUTION === 'true' AND a
 *     downstream caller that actually places orders. This module never sends
 *     orders itself.
 *   - When environment is missing or unknown it resolves to 'practice'.
 */

import { getCandles, getPricing, getOpenTrades, getForexSession } from './oandaMarketData.js';
import {
  analyzeMacro, analyzeStructure, analyzeMomentum,
  computeAlignment, computeConfidenceScore,
} from './oandaMtfAnalysis.js';
import {
  classifyTradeState,
} from './oandaTradeLifecycle.js';
import { analyzeRecentCandleStrength } from './oandaCandleStrength.js';
import { classifyMarketState }         from './oandaMarketState.js';
import { assessMtfAuthority }           from './oandaMtfAuthority.js';
import { classifyOverextension }        from './oandaOverextension.js';
import { analyzeInstitutionalFlow }     from './oandaInstitutionalFlow.js';
import { getInstrumentProfile }         from './oandaInstrumentProfiles.js';
import { atr as computeAtr } from './oandaIndicators.js';
import {
  computeTrailingStop, computePartialExit, computeTpReduction, computeProfitProtection,
} from './oandaTradeManagement.js';
import {
  detectInvalidation, detectVolatilityCollapse, detectTrendWeakening,
} from './oandaTradeInvalidation.js';
import {
  findTradeByBrokerOrderId, updateMaxFavorableExcursion,
} from './oandaTradeHistory.js';
import { getEnvironment, isLiveExecutionExplicitlyAllowed } from './oandaClient.js';
import { syncImmediatePartialTrades } from './oandaImmediatePartial.js';
import { analyzeTradeLifecycle } from './oandaTradeLifecycleEngine.js';
import { computeLiveV3TpHitConfidence, isPureV3TradeRecord } from './v3TpConfidence.js';
import { reassessV3OpenTrade } from './v3ActiveTradeMonitor.js';
import { reassessIctTrade } from './ictLifecycleEngine.js';
import { computeIctLifecycleConfidence, ictEntryConfidence, ictHoldMinutes, isIctTradeRecord } from './ictPolicy.js';

const AUTO_CLOSE_ENABLED =
  String(process.env.ENABLE_ACTIVE_TRADE_AUTO_CLOSE || 'false').toLowerCase() === 'true';

// The reassessor is analysis-only. Broker mutation is centralized in the
// authenticated management route, whose policy can tighten stops or take a
// bounded partial but cannot automatically liquidate a full trade.

const REASSESSMENT_INTERVAL_MS = Math.max(30 * 60 * 1000, Number(process.env.ACTIVE_TRADE_REASSESS_INTERVAL_MS || 30 * 60 * 1000)); // 30 min — hard minimum cadence
let _scheduler = null;

function nyMinutesSinceMidnight(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);

  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10) % 24;
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  return hour * 60 + minute;
}

function isPostEntryManagementWindow(now = new Date()) {
  return nyMinutesSinceMidnight(now) >= 14 * 60;
}

export function buildMarketAlignedRecommendation({
  baseRecommendation = null,
  currentConfidence = null,
  confidenceThreshold = 70,
  signalMisalignmentReasons = [],
  invalidationDetected = false,
  invalidationReason = null,
  flowOpposes = false,
  m15TrendReversed = false,
  profitR = null,
  liveAutoCloseEnabled = false,
} = {}) {
  const base = baseRecommendation || {};
  const reasons = Array.isArray(signalMisalignmentReasons)
    ? signalMisalignmentReasons.filter(Boolean)
    : [];
  const confidence = Number(currentConfidence);
  const confidenceKnown = Number.isFinite(confidence);
  const confidenceBelowThreshold = confidenceKnown && confidence < confidenceThreshold;
  const severeConfidenceLoss = confidenceKnown && confidence < Math.max(55, confidenceThreshold - 15);
  const signalMisaligned = reasons.length > 0;
  const reversalStack = flowOpposes && m15TrendReversed;
  const autoCloseReviewTriggered =
    invalidationDetected || confidenceBelowThreshold || signalMisaligned || reversalStack;

  let action = base.action || 'hold';
  let urgency = base.urgency || 'low';
  let recommendationConfidence = Number.isFinite(Number(base.confidence))
    ? Number(base.confidence)
    : 60;
  let summary = base.unifiedSummary || base.reason || 'Hold while the original thesis remains aligned.';
  let source = base.source || 'lifecycle';
  let autoCloseCandidate = action === 'close';
  let autoCloseReason = base.autoCloseReason || null;

  if (invalidationDetected) {
    action = 'close';
    urgency = 'high';
    recommendationConfidence = Math.max(recommendationConfidence, 92);
    source = 'thesis_invalidation';
    autoCloseCandidate = true;
    autoCloseReason = `thesis_invalidation:${invalidationReason || reasons[0] || 'initial signal no longer valid'}`;
    summary = `Close the position: the initial trade thesis is invalidated. ${invalidationReason || reasons.join(' ') || ''}`.trim();
  } else if (severeConfidenceLoss || reversalStack) {
    action = 'close';
    urgency = 'high';
    recommendationConfidence = Math.max(recommendationConfidence, 85);
    source = severeConfidenceLoss ? 'confidence_breakdown' : 'institutional_reversal';
    autoCloseCandidate = true;
    autoCloseReason = severeConfidenceLoss
      ? `confidence_below_${Math.max(55, confidenceThreshold - 15)}`
      : 'institutional_flow_and_m15_reversal';
    summary = `Close review is high priority: ${confidenceKnown ? `confidence is ${confidence}%` : 'confidence deteriorated'}${reasons.length ? ` and ${reasons.join('; ')}` : ''}.`;
  } else if (confidenceBelowThreshold && signalMisaligned) {
    action = (Number(profitR) > 0.5) ? 'tighten_sl' : 'close';
    urgency = 'medium';
    recommendationConfidence = Math.max(recommendationConfidence, 78);
    source = 'confidence_and_signal_misalignment';
    autoCloseCandidate = action === 'close';
    autoCloseReason = autoCloseCandidate ? `confidence_below_${confidenceThreshold}_with_misalignment` : null;
    summary = action === 'close'
      ? `Close review: confidence fell to ${confidence}% and the live market no longer aligns with the entry thesis (${reasons.join('; ')}).`
      : `Protect the open profit: confidence fell to ${confidence}% and the live market is misaligned (${reasons.join('; ')}). Tighten the stop rather than extending the target.`;
  } else if (confidenceBelowThreshold) {
    urgency = urgency === 'high' ? 'high' : 'medium';
    recommendationConfidence = Math.max(recommendationConfidence, 72);
    source = 'confidence_review';
    summary = `Reassess closely: current confidence ${confidence}% is below the ${confidenceThreshold}% management threshold, but there is not yet enough contradictory market evidence to force an automatic close.`;
  } else if (signalMisaligned) {
    urgency = urgency === 'high' ? 'high' : 'medium';
    recommendationConfidence = Math.max(recommendationConfidence, 70);
    source = 'signal_misalignment_review';
    summary = `The position needs active review because ${reasons.join('; ')}. ${summary}`;
  }

  const shouldAutoClose = Boolean(
    liveAutoCloseEnabled && autoCloseCandidate && urgency === 'high',
  );

  return {
    ...base,
    action,
    urgency,
    confidence: Math.round(recommendationConfidence),
    reason: summary,
    unifiedSummary: summary,
    source,
    shouldAutoClose,
    autoCloseReason: shouldAutoClose ? autoCloseReason : null,
    autoCloseCandidate,
    autoCloseReviewTriggered,
    confidenceThreshold,
    confidenceBelowThreshold,
    signalMisaligned,
    signalMisalignmentReasons: reasons,
  };
}

function getPipSize(pair) {
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return 0.01;
  if (pair && /^(NAS100|US30|SPX500|DE30|UK100)/.test(pair)) return 1.0;
  if (pair && pair.includes('JPY')) return 0.01;
  return 0.0001;
}

function maxSpreadFor(pair) {
  if (pair === 'EUR_USD') return 3;
  if (pair === 'GBP_USD') return 4;
  if (pair === 'AUD_USD') return 5;
  if (pair === 'USD_JPY') return 5;
  if (pair === 'NZD_USD') return 6;
  if (pair === 'USD_CAD') return 6;
  if (pair?.includes?.('JPY')) return 12;
  if (pair?.includes?.('GBP')) return 8;
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return 50;
  if (/^(NAS100|US30|SPX500|DE30|UK100)/.test(pair || '')) return 8;
  return 6;
}

/**
 * Build the full management plan for a single open trade.
 */
async function buildManagementPlanForTrade(oandaTrade, session, options = {}) {
  const { client } = options;
  const pair = oandaTrade.instrument;
  const units = parseFloat(oandaTrade.currentUnits);
  const side = units >= 0 ? 'long' : 'short';
  const entryPrice = parseFloat(oandaTrade.price);

  // openTime handling (mirrors active monitor — supports ISO + epoch-seconds strings)
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

  const currentSL = oandaTrade.stopLossOrder
    ? parseFloat(oandaTrade.stopLossOrder.price)
    : null;
  const currentTP = oandaTrade.takeProfitOrder
    ? parseFloat(oandaTrade.takeProfitOrder.price)
    : null;

  const historyRecord = findTradeByBrokerOrderId(String(oandaTrade.id));
  const pureIctTrade = isIctTradeRecord(historyRecord || {});
  if (isPureV3TradeRecord(historyRecord || {})) {
    return reassessV3OpenTrade(oandaTrade, { client, historyRecord, now: new Date() });
  }

  const pricing = (await getPricing([pair], { client }))[0];
  const currentPrice = pricing ? pricing.mid : entryPrice;

  // Fresh candles
  const [dailyCandles, h4Candles, h1Candles, m30Candles, m15Candles, m5Candles] = await Promise.all([
    getCandles(pair, 'D',   60,  { client }).catch(() => []),
    getCandles(pair, 'H4',  60,  { client }).catch(() => []),
    getCandles(pair, 'H1',  80,  { client }).catch(() => []),
    getCandles(pair, 'M30', 96,  { client }).catch(() => []),
    getCandles(pair, 'M15', 120, { client }).catch(() => []),
    getCandles(pair, 'M5',  120, { client }).catch(() => []),
  ]);

  // Re-run the waterfall
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

  // Extended analysis (same modules the scanner uses pre-entry)
  const profile = getInstrumentProfile(pair);
  const candleStrength = analyzeRecentCandleStrength({
    candles: m15Candles, direction: side, pair, atrPips: momentum.atrPips, window: 3,
  });
  const marketState = classifyMarketState({
    macro, structure, momentum,
    candlesM15: m15Candles, candlesH1: h1Candles, session,
  });
  const mtfAuthority = assessMtfAuthority({
    direction: side, h4Candles, h1Candles, m15Candles, macro, structure,
  });
  const overextension = classifyOverextension({
    candles: m15Candles, direction: side,
    atrPips: momentum.atrPips, pair, structure,
    srProximity: momentum.srProximity,
  });
  const institutionalFlow = analyzeInstitutionalFlow({
    pair, tradeDirection: side,
    m15Candles, h1Candles, h4Candles,
    priorTrend: macro.h4Trend,
    structureType: macro.marketStructure?.type,
  });

  // Pull entry-context from the trade history record (created at execution time)
  const entryContext = historyRecord ? {
    entryATR:                  historyRecord.entryATR,
    entryMarketState:          historyRecord.entryMarketState,
    entryMarketStateScore:     historyRecord.entryMarketStateScore,
    entryCandleStrengthScore:  historyRecord.entryCandleStrengthScore,
    entryMtfAlignmentScore:    historyRecord.entryMtfAlignmentScore,
    entrySelectedLogicType:    historyRecord.entrySelectedLogicType,
    entryAssetClass:           historyRecord.entryAssetClass,
    entryRiskRewardRatio:      historyRecord.entryRiskRewardRatio,
    entrySession:              historyRecord.entrySession,
    entrySpreadPips:           historyRecord.entrySpreadPips,
    entryExpectedHoldTimeMinutes: historyRecord.entryExpectedHoldTimeMinutes,
    originalRecommendedTP:     historyRecord.originalRecommendedTP,
    originalRecommendedSL:     historyRecord.originalRecommendedSL,
    entryTpHitConfidence:      historyRecord.entryTpHitConfidence,
    entryQualityConfidence:    historyRecord.entryQualityConfidence,
    entryStrategy:             historyRecord.entryStrategy,
  } : {};
  const pureV3Trade = false; // V3 trades returned before foreign analysis
  const originalSL = entryContext.originalRecommendedSL ?? currentSL;
  const originalTP = entryContext.originalRecommendedTP ?? currentTP;
  const expectedHoldTimeMinutes = pureIctTrade
    ? ictHoldMinutes(historyRecord || {}, entryContext.entryExpectedHoldTimeMinutes)
    : entryContext.entryExpectedHoldTimeMinutes ?? null;

  // R-multiple + tpProgress
  const pipSize = getPipSize(pair);
  const rPips = Number.isFinite(originalSL)
    ? Math.abs(entryPrice - originalSL) / pipSize
    : null;
  const profitPipsNow = side === 'long'
    ? (currentPrice - entryPrice) / pipSize
    : (entryPrice - currentPrice) / pipSize;
  const profitR = rPips ? +(profitPipsNow / rPips).toFixed(2) : null;

  const distToTpPips = Number.isFinite(currentTP)
    ? Math.max(0, side === 'long' ? (currentTP - currentPrice) / pipSize : (currentPrice - currentTP) / pipSize)
    : null;
  const distToSlPips = Number.isFinite(currentSL)
    ? Math.max(0, side === 'long' ? (currentPrice - currentSL) / pipSize : (currentSL - currentPrice) / pipSize)
    : null;
  const tpRangePips = Number.isFinite(originalTP)
    ? Math.abs(originalTP - entryPrice) / pipSize
    : null;
  const tpProgress = (tpRangePips && profitPipsNow > 0)
    ? Math.max(0, profitPipsNow / tpRangePips)
    : 0;

  // Update MFE in history
  const reassessedAt = new Date().toISOString();
  let mfePips = historyRecord?.maxFavorableExcursionPips ?? 0;
  if (profitPipsNow > mfePips) {
    const updated = updateMaxFavorableExcursion({
      id: historyRecord?.id, oandaOrderId: String(oandaTrade.id),
      currentMfePips: profitPipsNow, reassessedAt,
    });
    if (updated) mfePips = updated.maxFavorableExcursionPips;
  }

  // ── Run the four exit-side management functions ──────────────────────────
  const trailing = computeTrailingStop({
    side, entryPrice, currentPrice, originalSL,
    currentSL, pair, assetClass: profile.assetClass,
    marketState, m15Candles, atrPipsCurrent: momentum.atrPips,
    institutionalFlow,
  });
  const partial = computePartialExit({
    side, entryPrice, currentPrice, originalSL, originalTP,
    pair, marketState, structure, momentum,
    mtfAuthorityNow: mtfAuthority,
    mtfAuthorityAtEntry: entryContext.entryMtfAlignmentScore
      ? { multiTimeframeAlignmentScore: entryContext.entryMtfAlignmentScore }
      : null,
  });
  const tpReduction = computeTpReduction({
    side, entryPrice, currentPrice, originalSL, originalTP,
    pair, marketState, macro,
    atrPipsAtEntry: entryContext.entryATR,
    atrPipsCurrent: momentum.atrPips,
    momentum,
  });
  const profitProtection = computeProfitProtection({
    side, entryPrice, currentPrice, originalSL, originalTP,
    pair, maxFavorableExcursionPips: mfePips, momentum,
  });

  // ── Run the three invalidation / thesis-breaking checks ──────────────────
  const invalidation = detectInvalidation({
    side, entryPrice, currentPrice, originalSL, pair,
    macroNow: macro, structureNow: structure, mtfAuthorityNow: mtfAuthority,
    candleStrengthNow: candleStrength,
    institutionalFlow, marketStateNow: marketState,
    entryContext, expectedHoldTimeMinutes, minutesElapsed,
    pricing, atrPipsCurrent: momentum.atrPips,
  });
  const volatilityCollapse = detectVolatilityCollapse({
    pair, marketStateNow: marketState,
    atrPipsCurrent: momentum.atrPips,
    entryContext, m15Candles, tpProgress,
  });
  const trendWeakening = detectTrendWeakening({
    side, m15Candles, mtfAuthorityNow: mtfAuthority,
    entryContext, marketStateNow: marketState,
  });

  // Classic state classifier (existing system) — kept for the dashboard
  const classification = classifyTradeState({
    pair, side, entryPrice, currentPrice,
    stopLoss: currentSL ?? originalSL ?? entryPrice,
    takeProfit: currentTP ?? originalTP ?? entryPrice,
    currentWaterfall: { macro, structure, momentum, alignment },
    entryAlignmentScore: entryContext.entryMtfAlignmentScore,
    minutesElapsed,
    holdWindow: expectedHoldTimeMinutes
      ? { minMinutes: expectedHoldTimeMinutes / 2, maxMinutes: expectedHoldTimeMinutes * 2 }
      : null,
  });

  // ── Pick the highest-priority recommendation ─────────────────────────────
  // Priority: INVALIDATION (high) > VOLATILITY_COLLAPSE (high) >
  // PARTIAL_EXIT > TP_REDUCTION > PROFIT_PROTECTION (level 4) > TRAILING > HOLD
  let recommendedAction = 'HOLD';
  const managementReasons = [];

  if (invalidation.exitInvalidatedRecommended) {
    recommendedAction = 'EXIT_INVALIDATED';
    managementReasons.push(`Trade invalidated by HTF bias flip or structural break. ${invalidation.invalidationReason}`);
  } else if (volatilityCollapse.volatilityCollapsed && volatilityCollapse.volatilityCollapseSeverity === 'high') {
    recommendedAction = tpReduction.tpReductionRecommended ? 'REDUCE_TP' : 'EXIT_REVIEW';
    managementReasons.push(`TP reduced due to volatility collapse. ${volatilityCollapse.volatilityReason}`);
  } else if (profitProtection.profitProtectionTriggered && profitProtection.profitProtectionLevel >= 4) {
    recommendedAction = 'PROTECT_PROFIT';
    managementReasons.push(`Protect profit after major MFE giveback (${profitProtection.givebackPercent}%)`);
  } else if (partial.partialExitRecommended) {
    recommendedAction = 'PARTIAL_EXIT';
    managementReasons.push(`Partial exit recommended due to weakening trend near TP. ${partial.partialExitReason}`);
  } else if (tpReduction.tpReductionRecommended) {
    recommendedAction = 'REDUCE_TP';
    managementReasons.push(`Reduce TP. ${tpReduction.tpReductionReason}`);
  } else if (trailing.trailingStopRecommended && (profitR ?? 0) >= 1) {
    recommendedAction = profitR >= 1.5 ? 'TRAIL_SL' : 'MOVE_SL_TO_BREAKEVEN';
    managementReasons.push(profitR >= 1.5
      ? `Trail SL behind structure (+${profitR}R)`
      : `Move SL to breakeven after +${profitR}R`);
  } else if (trendWeakening.trendWeakeningDetected && trendWeakening.trendWeakeningSeverity === 'high') {
    recommendedAction = 'EXIT_REVIEW';
    managementReasons.push(`Trend weakening high. ${trendWeakening.trendWeakeningReason}`);
  }

  // Safety reasoning string (Part 12)
  const env = getEnvironment();
  const liveAllowed = isLiveExecutionExplicitlyAllowed();
  const safetyReason = liveAllowed && env === 'live'
    ? 'Live execution enabled — management actions can be applied.'
    : env === 'practice' || env === 'paper'
      ? 'Paper trading mode active: simulated management action available.'
      : 'Recommendation only: live execution disabled.';
  managementReasons.push(safetyReason);

  // ── Dynamic trade lifecycle engine ──────────────────────────────────────
  // Velocity, momentum decay, dynamic TP, hold-status, opportunity cost, and
  // recommendation are computed by a pure engine on top of the inputs the
  // reassessor already gathered. Auto-close is gated by the platform flag.
  const originalTpPips = Number.isFinite(originalTP)
    ? Math.abs(originalTP - entryPrice) / pipSize
    : null;
  const flowMatchesDirection =
    institutionalFlow?.detected &&
    institutionalFlow.direction === (side === 'long' ? 'bullish' : 'bearish');
  const flowOpposes =
    institutionalFlow?.detected &&
    institutionalFlow.direction !== 'neutral' &&
    institutionalFlow.direction !== (side === 'long' ? 'bullish' : 'bearish');
  const m15TrendReversed =
    (side === 'long' && momentum.m15Trend === 'bearish') ||
    (side === 'short' && momentum.m15Trend === 'bullish');
  const marketStateAllowed = profile.allowedMarketStates?.includes(marketState.marketState) ?? true;


  // Pure V3 positions must never be re-scored by the legacy entry-confidence model.
  // Entry V3 score is only the starting probability; there is deliberately no floor.
  const ictLifecycle = pureIctTrade
    ? reassessIctTrade({
        pair, direction: side, entryPrice, currentPrice, target1: currentTP ?? originalTP,
        candles: m5Candles, now: new Date(), openedAtMs: openTimeMs, holdMinutes: expectedHoldTimeMinutes,
        lastReassessMs: historyRecord?.lastReassessedAt ? Date.parse(historyRecord.lastReassessedAt) : null,
      })
    : null;
  const lockedIctEntryConfidence = pureIctTrade ? ictEntryConfidence(historyRecord || {}, 93) : null;

  const liveV3Confidence = pureV3Trade
    ? computeLiveV3TpHitConfidence({
        side,
        entryPrice,
        currentPrice,
        stopLoss: currentSL ?? originalSL,
        takeProfit: currentTP ?? originalTP,
        entryTpHitConfidence: entryContext.entryTpHitConfidence,
        historyRecord,
        profitR,
        tpProgress,
        entryAlignmentScore: entryContext.entryMtfAlignmentScore,
        currentAlignmentScore: alignment.timeframeAlignmentScore,
        entryMtfScore: entryContext.entryMtfAlignmentScore,
        currentMtfScore: mtfAuthority.multiTimeframeAlignmentScore,
        mtfConflict: mtfAuthority.conflict,
        flowOpposes,
        flowMatchesDirection,
        m15TrendReversed,
        volatilityCollapsed: volatilityCollapse.volatilityCollapsed,
        invalidationDetected: invalidation.invalidationDetected,
        trendWeakeningDetected: trendWeakening.trendWeakeningDetected,
        trendWeakeningSeverity: trendWeakening.trendWeakeningSeverity,
      })
    : null;
  let currentConfidence = pureIctTrade
    ? lockedIctEntryConfidence
    : liveV3Confidence?.tpHitConfidence ?? legacyCurrentConfidence;

  if (
    pureV3Trade &&
    liveV3Confidence &&
    (liveV3Confidence.exitRecommendation === 'EXIT_NOW' || liveV3Confidence.exitRecommendation === 'EXIT_REVIEW') &&
    recommendedAction === 'HOLD'
  ) {
    recommendedAction = 'EXIT_REVIEW';
    managementReasons.push(
      `V3 live TP-hit confidence fell to ${liveV3Confidence.tpHitConfidence}% ` +
      `(${liveV3Confidence.state}); entry V3 score is not used as a post-entry floor.`
    );
  }

  if (pureIctTrade && ictLifecycle) {
    if (!ictLifecycle.pastHold) {
      recommendedAction = 'HOLD';
      managementReasons.unshift(
        `ICT hold protection: preserving qualified ${lockedIctEntryConfidence}% entry confidence until ` +
        `${expectedHoldTimeMinutes} minutes; scanner requalification and legacy confidence are ignored.`
      );
    } else if (ictLifecycle.reassessDue) {
      const actionMap = { PARTIAL_CLOSE: 'PARTIAL_EXIT',
        MOVE_BREAKEVEN: 'MOVE_SL_TO_BREAKEVEN', HOLD: 'HOLD' };
      recommendedAction = actionMap[ictLifecycle.action] || 'HOLD';
      managementReasons.unshift(...ictLifecycle.reasons);
    } else {
      recommendedAction = 'HOLD';
      managementReasons.unshift(...ictLifecycle.reasons);
    }
    currentConfidence = computeIctLifecycleConfidence({
      entryConfidence: lockedIctEntryConfidence, minutesElapsed, holdMinutes: expectedHoldTimeMinutes,
      lifecycleAction: ictLifecycle.action, profitR, tpProgress,
    });
  }


  const confidenceReviewThreshold = Math.max(
    1,
    Number(process.env.ACTIVE_TRADE_CLOSE_REVIEW_CONFIDENCE || 70),
  );
  const initialConfidence = Number.isFinite(Number(entryContext.entryTpHitConfidence))
    ? Number(entryContext.entryTpHitConfidence)
    : Number.isFinite(Number(entryContext.entryQualityConfidence))
      ? Number(entryContext.entryQualityConfidence)
      : null;
  const alignmentDrop = Number.isFinite(Number(entryContext.entryMtfAlignmentScore))
    ? Math.max(0, Number(entryContext.entryMtfAlignmentScore) - Number(alignment.timeframeAlignmentScore || 0))
    : 0;
  const mtfAlignmentDrop = Number.isFinite(Number(entryContext.entryMtfAlignmentScore))
    ? Math.max(0, Number(entryContext.entryMtfAlignmentScore) - Number(mtfAuthority.multiTimeframeAlignmentScore || 0))
    : 0;
  const signalMisalignmentReasons = [];
  if (mtfAuthority.conflict) signalMisalignmentReasons.push('multi-timeframe direction is conflicting');
  if (flowOpposes) signalMisalignmentReasons.push('institutional flow opposes the open position');
  if (m15TrendReversed) signalMisalignmentReasons.push('the M15 trend reversed against the position');
  if (alignmentDrop >= 15) signalMisalignmentReasons.push(`alignment fell ${Math.round(alignmentDrop)} points from entry`);
  if (mtfAlignmentDrop >= 15) signalMisalignmentReasons.push(`MTF alignment fell ${Math.round(mtfAlignmentDrop)} points from entry`);
  if (!marketStateAllowed) signalMisalignmentReasons.push(`current market state ${marketState.marketState} is outside the entry profile`);

  const originalSlPips = Number.isFinite(originalSL)
    ? Math.abs(entryPrice - originalSL) / pipSize
    : null;
  const lifecycle = analyzeTradeLifecycle({
    pair,
    tradeId: String(oandaTrade.id),
    side,
    entryPrice,
    currentPrice,
    currentSL,
    originalTpPips,
    originalSlPips,
    expectedRR: entryContext.entryRiskRewardRatio,
    minutesElapsed,
    expectedHoldTimeMinutes,
    profitR,
    profitPipsNow,
    tpProgress,
    pipSize,
    entryAlignmentScore: entryContext.entryMtfAlignmentScore,
    currentAlignmentScore: alignment.timeframeAlignmentScore,
    entryMtfScore: entryContext.entryMtfAlignmentScore,
    currentMtfScore: mtfAuthority.multiTimeframeAlignmentScore,
    candleStrengthScore: candleStrength.candleStrengthScore,
    atrPipsAtEntry: entryContext.entryATR,
    atrPipsCurrent: momentum.atrPips,
    mtfConflict: mtfAuthority.conflict,
    flowOpposes,
    flowMatchesDirection,
    m15TrendReversed,
    volatilityCollapsed: volatilityCollapse.volatilityCollapsed,
    invalidationDetected: invalidation.invalidationDetected,
    invalidationReason: invalidation.invalidationReason,
    currentConfidence,
    spreadPips: pricing?.spreadPips,
    maxSpreadPips: maxSpreadFor(pair),
    marketStateAllowed,
    liveAutoCloseEnabled: AUTO_CLOSE_ENABLED,
  });
  console.log(lifecycle.logLine);

  const lifecycleRecommendation = buildMarketAlignedRecommendation({
    baseRecommendation: lifecycle.recommendation,
    currentConfidence,
    confidenceThreshold: confidenceReviewThreshold,
    signalMisalignmentReasons,
    invalidationDetected: invalidation.invalidationDetected,
    invalidationReason: invalidation.invalidationReason,
    flowOpposes,
    m15TrendReversed,
    profitR,
    liveAutoCloseEnabled: AUTO_CLOSE_ENABLED,
  });
  if (pureIctTrade && ictLifecycle) {
    const actionMap = {
      PARTIAL_CLOSE: 'partial_close', MOVE_BREAKEVEN: 'tighten_sl', HOLD: 'hold',
    };
    const ictAction = actionMap[ictLifecycle.action] || 'hold';
    lifecycleRecommendation.action = ictAction;
    lifecycleRecommendation.urgency = ictLifecycle.action === 'HOLD' ? 'low' : 'medium';
    lifecycleRecommendation.confidence = currentConfidence;
    lifecycleRecommendation.reason = (ictLifecycle.reasons || ['ICT entry thesis remains active.']).join(' ');
    lifecycleRecommendation.unifiedSummary = lifecycleRecommendation.reason;
    lifecycleRecommendation.source = 'ict_target_hit_lifecycle';
    lifecycleRecommendation.shouldAutoClose = false;
    lifecycleRecommendation.autoCloseCandidate = false;
    lifecycleRecommendation.autoCloseReviewTriggered = false;
    lifecycleRecommendation.confidenceBelowThreshold = currentConfidence < confidenceReviewThreshold;
    lifecycleRecommendation.signalMisaligned = false;
    lifecycleRecommendation.signalMisalignmentReasons = [];
  }
  const autoCloseAnalysis = {
    evaluated: lifecycleRecommendation.autoCloseReviewTriggered,
    candidate: lifecycleRecommendation.autoCloseCandidate,
    enabled: AUTO_CLOSE_ENABLED,
    shouldAutoClose: lifecycleRecommendation.shouldAutoClose,
    threshold: confidenceReviewThreshold,
    triggers: [
      ...(lifecycleRecommendation.confidenceBelowThreshold
        ? [`confidence ${Math.round(currentConfidence)}% below ${confidenceReviewThreshold}%`]
        : []),
      ...signalMisalignmentReasons,
      ...(invalidation.invalidationDetected
        ? [invalidation.invalidationReason || 'trade thesis invalidated']
        : []),
    ],
  };

  return {
    tradeId: String(oandaTrade.id),
    instrument: pair,
    direction: side,
    units: Math.abs(units),                              // absolute, for partial-close math
    initialUnits: Math.abs(Number(oandaTrade.initialUnits ?? historyRecord?.units ?? units)),
    assetClass: profile.assetClass,
    selectedLogicType: entryContext.entrySelectedLogicType ??
      (profile.assetClass === 'Metal' ? 'metals' :
       profile.assetClass === 'Index' ? 'indices' : 'forex'),
    environment: env,
    entryPrice: +entryPrice.toFixed(5),
    currentPrice: +currentPrice.toFixed(5),
    currentPnL: parseFloat(oandaTrade.unrealizedPL || 0),
    profitRMultiple: profitR,
    distanceToTP: distToTpPips,
    distanceToSL: distToSlPips,
    currentStopLoss: Number.isFinite(currentSL) ? currentSL : null,
    originalStopLoss: Number.isFinite(originalSL) ? originalSL : null,
    initialRiskPips: originalSlPips,
    marketState: marketState.marketState,
    marketStateScore: marketState.marketStateScore,
    candleStrengthScore: candleStrength.candleStrengthScore,
    multiTimeframeAlignmentScore: mtfAuthority.multiTimeframeAlignmentScore,
    volatilityCollapsed: volatilityCollapse.volatilityCollapsed,
    volatilityCollapseSeverity: volatilityCollapse.volatilityCollapseSeverity,
    trendWeakeningDetected: trendWeakening.trendWeakeningDetected,
    trendWeakeningSeverity: trendWeakening.trendWeakeningSeverity,
    invalidationDetected: invalidation.invalidationDetected,
    invalidationSeverity: invalidation.invalidationSeverity,
    profitProtectionTriggered: profitProtection.profitProtectionTriggered,
    profitProtectionLevel: profitProtection.profitProtectionLevel,
    maxFavorableExcursion: profitProtection.maxFavorableExcursion,
    givebackPercent: profitProtection.givebackPercent,
    recommendedAction,
    recommendedStopLoss: trailing.recommendedStopLoss,
    recommendedTakeProfit: tpReduction.recommendedTakeProfit,
    partialExitPercent: partial.partialExitPercent,
    managementReasons,
    classicTradeState: classification.tradeState,
    classicExitRecommendation: classification.exitRecommendation,
    classicReviewAction: classification.reviewAction,
    currentAlignmentScore: alignment.timeframeAlignmentScore,
    currentConfidence,
    initialConfidence,
    confidenceReviewThreshold,
    confidenceBelowReviewThreshold: lifecycleRecommendation.confidenceBelowThreshold,
    signalMisaligned: lifecycleRecommendation.signalMisaligned,
    signalMisalignmentReasons: pureIctTrade ? (lifecycleRecommendation.signalMisalignmentReasons || []) : signalMisalignmentReasons,
    institutionalFlow: {
      detected: !!institutionalFlow?.detected,
      direction: institutionalFlow?.direction || 'neutral',
      aligned: !!flowMatchesDirection,
      opposes: !!flowOpposes,
      reason: institutionalFlow?.reason || null,
      signals: Array.isArray(institutionalFlow?.signals) ? institutionalFlow.signals.slice(0, 5) : [],
    },
    marketMovement: {
      currentPrice: +currentPrice.toFixed(5),
      entryPrice: +entryPrice.toFixed(5),
      profitPips: +profitPipsNow.toFixed(1),
      profitR,
      m15Trend: momentum.m15Trend || 'neutral',
      candleStrengthScore: candleStrength.candleStrengthScore,
      velocityScore: lifecycle.velocityScore,
      momentumStatus: lifecycle.momentumStatus,
    },
    autoCloseAnalysis,
    confidenceModel: pureIctTrade
      ? 'ict_entry_locked_until_hold_then_ict_lifecycle'
      : pureV3Trade ? 'v3_live_tp_hit' : 'legacy_mtf',
    entryTpHitConfidence: entryContext.entryTpHitConfidence ?? null,
    entryQualityConfidence: entryContext.entryQualityConfidence ?? null,
    liveTpConfidence: liveV3Confidence,
    minutesElapsed,
    expectedHoldTimeMinutes,
    entryIctConfidence: lockedIctEntryConfidence,
    ictLifecycle,
    tpProgress: +tpProgress.toFixed(2),
    originalTargetReached: tpProgress >= 1,
    lastReassessedAt: reassessedAt,
    nextReassessmentDueAt: new Date(Date.now() + REASSESSMENT_INTERVAL_MS).toISOString(),
    // Dynamic lifecycle engine output — UI renders these on the reassess card.
    velocityScore: lifecycle.velocityScore,
    momentumDecayScore: lifecycle.momentumDecayScore,
    momentumStatus: lifecycle.momentumStatus,
    holdStatus: lifecycle.holdStatus,
    holdRatio: lifecycle.holdRatio,
    expectedRemainingHoldTime: lifecycle.expectedRemainingHoldTime,
    dynamicTP: lifecycle.dynamicTP,
    opportunityCostScore: lifecycle.opportunityCostScore,
    // Signal Stack V3 — pro exit framework
    breakeven:           lifecycle.breakeven,
    multiTargets:        lifecycle.multiTargets,
    partialClose:        lifecycle.partialClose,
    dynamicTrail:        lifecycle.dynamicTrail,
    trendExhaustion:     lifecycle.trendExhaustion,
    capitalEfficiency:   lifecycle.capitalEfficiency,
    lifecycleRecommendation,
    detail: {
      trailing, partial, tpReduction, profitProtection,
      invalidation, volatilityCollapse, trendWeakening,
      entryContext,
      lifecycle,
    },
  };
}

/**
 * Public — reassess every currently-open trade.
 *
 * Returns the shape from Part 1 + Part 11 of the spec:
 *   {
 *     trades: [ … per-trade management plan … ],
 *     meta: { reassessedAt, session, environment, autoCloseEnabled, totalActive, notice? }
 *   }
 */
/**
 * @param {Object} [options]
 * @param {Object} [options.client] — per-request OANDA client. When omitted,
 *   the legacy env-based default client is used (dev fallback).
 */
export async function reassessActiveTrades(options = {}) {
  const { client } = options;
  const session = getForexSession();
  const environment = client?.environment || getEnvironment();
  let openTrades = [];
  try {
    openTrades = await getOpenTrades({ client });
  } catch (err) {
    return {
      trades: [],
      meta: {
        reassessedAt: new Date().toISOString(),
        session,
        environment,
        totalActive: 0,
        error: `Failed to fetch open trades: ${err?.message ?? err}`,
      },
    };
  }
  // Recovery path after a backend restart: authenticated reassessment
  // refreshes the account's live pricing-stream registrations.
  syncImmediatePartialTrades(openTrades, { client });

  if (!openTrades.length) {
    return {
      trades: [],
      meta: {
        reassessedAt: new Date().toISOString(),
        session,
        environment,
        totalActive: 0,
        autoCloseEnabled: AUTO_CLOSE_ENABLED,
        autoCloseWindowActive: isPostEntryManagementWindow(new Date()),
        autoCloseResults: [],
        notice: 'No open positions on broker account',
      },
    };
  }

  const trades = await Promise.all(
    openTrades.map(t =>
      buildManagementPlanForTrade(t, session, { client }).catch(err => ({
        tradeId: String(t.id),
        instrument: t.instrument,
        error: err?.message || String(err),
      })),
    ),
  );


  const autoCloseResults = [];

  const recCounts = trades.reduce((acc, t) => {
    if (t.recommendedAction) acc[t.recommendedAction] = (acc[t.recommendedAction] || 0) + 1;
    return acc;
  }, {});

  return {
    trades,
    meta: {
      reassessedAt: new Date().toISOString(),
      session,
      environment,
      autoCloseEnabled: AUTO_CLOSE_ENABLED,
      automaticFullCloseEnabled: false,
      autoCloseWindowActive: isPostEntryManagementWindow(new Date()),
      autoCloseResults,
      totalActive: trades.length,
      recommendationCounts: recCounts,
      nextReassessmentDueAt: new Date(Date.now() + REASSESSMENT_INTERVAL_MS).toISOString(),
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PART 10 — 30-MINUTE SCHEDULER (env-guarded, hot-reload-safe)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Start the 30-min reassessment loop. Idempotent — calling twice doesn't
 * create duplicate intervals. The env guard ENABLE_ACTIVE_TRADE_REASSESSMENT
 * MUST be 'true' or the scheduler is a no-op.
 */
export function startReassessmentScheduler({ intervalMs = REASSESSMENT_INTERVAL_MS } = {}) {
  if (String(process.env.ENABLE_ACTIVE_TRADE_REASSESSMENT || 'false').toLowerCase() !== 'true') {
    console.log('[REASSESSOR] ENABLE_ACTIVE_TRADE_REASSESSMENT!=true — scheduler not started');
    return { started: false, reason: 'disabled_by_env' };
  }
  if (_scheduler) {
    console.log('[REASSESSOR] Scheduler already running — skipping duplicate start');
    return { started: false, reason: 'already_running' };
  }
  console.log(`[REASSESSOR] Starting 30-min active-trade reassessment scheduler (interval ${intervalMs}ms)`);
  _scheduler = setInterval(() => {
    reassessActiveTrades()
      .then(res => console.log(`[REASSESSOR] ✓ Reassessed ${res.meta.totalActive} trade(s)`))
      .catch(err => console.error(`[REASSESSOR] ✗ Reassessment failed: ${err?.message ?? err}`));
  }, intervalMs);
  if (typeof _scheduler.unref === 'function') _scheduler.unref();
  return { started: true, intervalMs };
}

export function stopReassessmentScheduler() {
  if (_scheduler) {
    clearInterval(_scheduler);
    _scheduler = null;
    return { stopped: true };
  }
  return { stopped: false, reason: 'not_running' };
}

// Used in tests + verification
export const __INTERNALS__ = { buildManagementPlanForTrade, REASSESSMENT_INTERVAL_MS };

// Silence unused-import lint (kept for future ATR-comparison expansion)
void computeAtr;
