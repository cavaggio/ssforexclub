#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'server', 'ictEngine.js');
const EXECUTION = path.join(ROOT, 'server', 'ictExecution.js');
const MONITOR = path.join(ROOT, 'server', 'oandaActiveTradeMonitor.js');
const REASSESSOR = path.join(ROOT, 'server', 'oandaActiveTradeReassessor.js');

function replaceRequired(text, pattern, replacement, label) {
  if (typeof replacement === 'string' && text.includes(replacement)) return text;
  const next = text.replace(pattern, replacement);
  if (next === text) throw new Error(`ICT confidence-alignment marker missing: ${label}`);
  return next;
}

function insertAfter(text, anchor, addition, label) {
  if (text.includes(addition.trim())) return text;
  if (!text.includes(anchor)) throw new Error(`ICT confidence-alignment anchor missing: ${label}`);
  return text.replace(anchor, `${anchor}${addition}`);
}

// ── Scanner / signal engine ───────────────────────────────────────────────────
let engine = fs.readFileSync(ENGINE, 'utf8');
engine = insertAfter(
  engine,
  "import { classifyIctStrategy, computeAdaptiveIctStop } from './ictPolicy.js';\n",
  "import { computeIctTargetHitConfidence } from './ictTargetConfidence.js';\n",
  'target confidence import',
);
engine = replaceRequired(
  engine,
  '  const entry = roundPrice(zoneMid, pair);',
  `  // ICT submits MARKET orders. The executable entry is therefore the current
  // market price, while the PD-array midpoint is retained only as the ideal entry
  // reference used to detect late/chasing entries.
  const idealEntry = roundPrice(zoneMid, pair);
  const entry = roundPrice(currentPrice, pair);`,
  'market entry geometry',
);
engine = replaceRequired(
  engine,
  `    entrySource,
    entry,
    stopLoss,`,
  `    entrySource,
    entry,
    idealEntry,
    entryZoneLow: roundPrice(zoneLow, pair),
    entryZoneHigh: roundPrice(zoneHigh, pair),
    stopLoss,`,
  'entry-zone metadata',
);

const confidenceBlock = `  const labelCount = [powerOf3?.phase === 'Distribution', silverBulletWindow, turtleSoup.turtleSoupDetected, judas.judasSwingDetected].filter(Boolean).length;
  const confluenceScore = computeIctConfidence({
    htfAligned,
    killzoneQuality: kz.inKillzone ? kz.killzoneQuality : 0,
    sweepAligned, drawPresent, entryTrigger,
    displacementAligned, mssOrChoch: reversalConfirmed || bosAligned,
    fvgInDir, obInDir, inOteZone, smt: smt.smtDetected,
    inducementSwept: inducement.inducementSwept, labels: labelCount,
    rr: setup?.ok ? setup.rr : null,
  });

  // A scalp may qualify only from a CURRENT 5M impulse/structure trigger. Static
  // location context (FVG/OB/OTE) can add confluence but cannot independently
  // authorize a market order after the move has already happened.
  const displacementAgeBars = displacementAligned && Number.isInteger(displacement?.candleIndex)
    ? Math.max(0, entryTf.length - 1 - displacement.candleIndex)
    : null;
  const triggerAges = [
    sweepAligned ? 0 : null,
    reversalConfirmed ? 0 : null,
    bosAligned ? 0 : null,
    displacementAgeBars,
  ].filter(Number.isFinite);
  const triggerAgeBars = triggerAges.length ? Math.min(...triggerAges) : null;
  const freshImpulse = Number.isFinite(triggerAgeBars) && triggerAgeBars <= 1;

  const timing = gradeTiming({ pair, currentPrice, setup, atrPrice });
  const idealEntry = Number(setup?.idealEntry ?? setup?.entry);
  const entryDriftAtr = atrPrice && Number.isFinite(idealEntry)
    ? Math.abs(currentPrice - idealEntry) / atrPrice
    : 99;
  const targetPrice = Number(setup?.target1);
  const totalTargetMove = Number.isFinite(idealEntry) && Number.isFinite(targetPrice)
    ? Math.abs(targetPrice - idealEntry)
    : 0;
  const consumedMove = Number.isFinite(idealEntry)
    ? Math.max(0, dir === 'long' ? currentPrice - idealEntry : idealEntry - currentPrice)
    : 0;
  const rewardConsumedFraction = totalTargetMove > 0 ? consumedMove / totalTargetMove : 1;
  const zoneLowNow = Number(setup?.entryZoneLow);
  const zoneHighNow = Number(setup?.entryZoneHigh);
  const zoneTolerance = atrPrice ? atrPrice * 0.10 : 0;
  const priceInsideEntryZone = setup?.entrySource === 'MARKET' || (
    Number.isFinite(zoneLowNow) && Number.isFinite(zoneHighNow) &&
    currentPrice >= Math.min(zoneLowNow, zoneHighNow) - zoneTolerance &&
    currentPrice <= Math.max(zoneLowNow, zoneHighNow) + zoneTolerance
  );
  const executableRisk = setup?.ok ? Math.abs(currentPrice - setup.stopLoss) : 0;
  const executableReward = setup?.ok ? Math.abs(setup.target1 - currentPrice) : 0;
  const executableRR = executableRisk > 0 ? executableReward / executableRisk : 0;
  const targetConfidence = computeIctTargetHitConfidence({
    confluenceScore,
    freshImpulse,
    triggerAgeBars,
    entryDriftAtr,
    rewardConsumedFraction,
    priceInsideEntryZone,
    actualRR: executableRR,
    minimumRR: configuredIctMinRR(),
    targetAdjusted: Boolean(setup?.targetAdjustedToMinRR),
    spreadPips: 0,
    maxSpreadPips: Number(process.env.ICT_MAX_SPREAD_PIPS || process.env.FOREX_MAX_SPREAD_PIPS || 3.5),
    minConfidence: ictExecConfig().minConfidence,
  });
  const confidence = targetConfidence.confidence;

  if (!freshImpulse) hardFails.push('Hard gate: no fresh 5M impulse/structure trigger for a market scalp entry.');
  if (entryDriftAtr > 0.35) hardFails.push(\`Hard gate: late market entry — price drifted \${entryDriftAtr.toFixed(2)} ATR from the ideal ICT entry.\`);
  if (rewardConsumedFraction > 0.20) hardFails.push(\`Hard gate: late market entry — \${Math.round(rewardConsumedFraction * 100)}% of the target move was already consumed.\`);
  if (!priceInsideEntryZone) hardFails.push('Hard gate: current market price is outside the valid ICT entry zone.');
  if (setup?.targetAdjustedToMinRR) hardFails.push('Hard gate: nearest natural liquidity target does not provide the minimum R:R from the current market entry.');
  if (setup?.ok && executableRR < configuredIctMinRR()) hardFails.push(\`Hard gate: executable R:R \${executableRR.toFixed(2)} is below \${configuredIctMinRR().toFixed(2)}.\`);

  // ── DECISION — target-hit confidence, not raw confluence, is authoritative ──
  const DISPLAY_MIN = ictExecConfig().minConfidence;
  if (hardFails.length === 0 && want && setup?.ok && confidence >= DISPLAY_MIN && targetConfidence.eligible) {
    signal = want === 'bullish' ? 'buy' : 'sell';
    setupType = classifyIctStrategy({
      silverBulletWindow,
      turtleSoup: turtleSoup.turtleSoupDetected,
      judasSwing: judas.judasSwingDetected,
      powerOf3Distribution: powerOf3?.phase === 'Distribution',
      sweepAligned, displacementAligned, reversalConfirmed, bosAligned,
      fvgInDir, obInDir, inOteZone,
      breakerConfirmed: Boolean(orderBlock?.failed || orderBlock?.breaker || orderBlock?.invalidated),
    });
  }

  rejectionReasons.push(...hardFails);
  if (signal === 'none' && hardFails.length === 0) {
    rejectionReasons.push(
      \`Target-hit confidence below execution threshold: \${confidence} < \${DISPLAY_MIN}. \` +
      \`Timing \${targetConfidence.timingScore}/100, geometry \${targetConfidence.geometryScore}/100, \` +
      \`confluence \${targetConfidence.confluenceScore}/100.\`
    );
  }
  void pendingSweepDir; // Minimum R:R is already constructed into setup.target1.
`;
engine = replaceRequired(
  engine,
  /  const labelCount = \[powerOf3\?\.phase === 'Distribution',[\s\S]*?  void pendingSweepDir; \/\/ Minimum R:R is already constructed into setup\.target1\.\n/,
  confidenceBlock,
  'target-hit decision block',
);
engine = engine.replace(
  "  // Timing grade.\n  const timing = gradeTiming({ pair, currentPrice, setup, atrPrice });\n",
  "  // Timing was calculated before qualification so stale/late entries cannot be promoted.\n",
);
engine = replaceRequired(
  engine,
  `    atrPips,
    riskModel: setup?.ok ? setup.riskModel ?? null : null,
    confidence,`,
  `    atrPips,
    riskModel: setup?.ok ? setup.riskModel ?? null : null,
    confidence,
    targetHitConfidence: confidence,
    confluenceScore,
    targetConfidence,
    freshImpulse,
    triggerAgeBars,
    idealEntry: setup?.ok ? setup.idealEntry ?? null : null,
    entryZoneLow: setup?.ok ? setup.entryZoneLow ?? null : null,
    entryZoneHigh: setup?.ok ? setup.entryZoneHigh ?? null : null,
    targetAdjustedToMinRR: Boolean(setup?.targetAdjustedToMinRR),`,
  'target confidence response metadata',
);
fs.writeFileSync(ENGINE, engine);

// ── Final pre-fill execution confirmation ─────────────────────────────────────
let execution = fs.readFileSync(EXECUTION, 'utf8');
execution = insertAfter(
  execution,
  "import { applyBoundedIctStopWidening } from './ictPolicy.js';\n",
  "import { repriceIctTargetHitConfidence } from './ictTargetConfidence.js';\n",
  'execution confidence import',
);
const finalConfirmation = `
  const executablePrice = direction === 'long' ? protectiveCheck.ask : protectiveCheck.bid;
  const finalTargetConfidence = repriceIctTargetHitConfidence({
    analysis,
    pair,
    direction,
    executablePrice,
    spreadPips: freshSpreadPips,
    maxSpreadPips: maxFreshSpreadPips,
    minConfidence: config.minConfidence,
  });
  if (!finalTargetConfidence.eligible || finalTargetConfidence.confidence < config.minConfidence) {
    return blocked(
      \`Final executable-price target-hit confirmation rejected: \${finalTargetConfidence.blockers.join('; ') || 'confidence gate failed'}.\`,
      { finalTargetConfidence },
    );
  }
  entry = executablePrice;
  analysis = {
    ...analysis,
    entry,
    rr: finalTargetConfidence.actualRR,
    confidence: finalTargetConfidence.confidence,
    targetHitConfidence: finalTargetConfidence.confidence,
    targetConfidence: finalTargetConfidence,
  };
`;
execution = insertAfter(
  execution,
  `  if (Number.isFinite(freshSpreadPips) && freshSpreadPips > maxFreshSpreadPips) {
    return blocked(\`Fresh spread \${freshSpreadPips.toFixed(1)}p exceeds ICT maximum \${maxFreshSpreadPips.toFixed(1)}p.\`);
  }
`,
  finalConfirmation,
  'final executable target confirmation',
);
execution = execution.replace(
  "      confidence: analysis.confidence, entryQualityConfidence: analysis.confidence, entryTpHitConfidence: analysis.confidence,\n      entryStrategy: 'ICT', strategy: 'ICT', score: analysis.confidence,\n      scoreBreakdown: { setupType: analysis.setupType, conceptsDetected: analysis.conceptsDetected, riskModel: analysis.riskModel, claudeStopAdvice: analysis.claudeStopAdvice },",
  "      confidence: analysis.targetHitConfidence ?? analysis.confidence,\n      entryQualityConfidence: analysis.confluenceScore ?? analysis.targetConfidence?.confluenceScore ?? analysis.confidence,\n      entryTpHitConfidence: analysis.targetHitConfidence ?? analysis.confidence,\n      entryStrategy: 'ICT', strategy: 'ICT', score: analysis.confluenceScore ?? analysis.confidence,\n      scoreBreakdown: { setupType: analysis.setupType, conceptsDetected: analysis.conceptsDetected, riskModel: analysis.riskModel, claudeStopAdvice: analysis.claudeStopAdvice, targetConfidence: analysis.targetConfidence },",
);
execution = execution.replace(
  '    entryConfidence: analysis.confidence,',
  '    entryConfidence: analysis.targetHitConfidence ?? analysis.confidence,\n    entryQualityConfidence: analysis.confluenceScore ?? analysis.targetConfidence?.confluenceScore ?? null,\n    targetConfidence: analysis.targetConfidence ?? null,',
);
fs.writeFileSync(EXECUTION, execution);

// ── Open-trade card: ICT uses the same persisted target-hit confidence ─────────
let monitor = fs.readFileSync(MONITOR, 'utf8');
monitor = insertAfter(
  monitor,
  "import { analyzeV3OpenTrade } from './v3ActiveTradeMonitor.js';\n",
  "import { reassessIctTrade } from './ictLifecycleEngine.js';\nimport { computeIctLifecycleConfidence, ictEntryConfidence, ictHoldMinutes, isIctTradeRecord } from './ictPolicy.js';\nimport { ictProbabilitiesFromConfidence } from './ictTargetConfidence.js';\n",
  'open monitor ICT imports',
);
monitor = insertAfter(
  monitor,
  '  const historyRecord = findTradeByBrokerOrderId(String(oandaTrade.id));\n',
  '  const pureIctTrade = isIctTradeRecord(historyRecord || {});\n',
  'open monitor ICT attribution',
);
const monitorConfidenceBlock = `  const pureV3Trade = false; // V3 trades returned before foreign analysis
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

  const expectedHoldTimeMinutes = pureIctTrade ? ictHoldMinutes(historyRecord || {}) : null;
  const ictLifecycle = pureIctTrade
    ? reassessIctTrade({
        pair,
        direction: side,
        entryPrice,
        currentPrice,
        target1: takeProfit,
        candles: m5Candles,
        now: new Date(),
        openedAtMs: openTimeMs,
        holdMinutes: expectedHoldTimeMinutes,
        lastReassessMs: historyRecord?.lastReassessedAt ? Date.parse(historyRecord.lastReassessedAt) : null,
      })
    : null;
  const entryIctConfidence = pureIctTrade ? ictEntryConfidence(historyRecord || {}, 93) : null;
  const originalStop = Number(historyRecord?.originalRecommendedSL ?? stopLoss);
  const initialRiskPips = Number.isFinite(originalStop) ? Math.abs(entryPrice - originalStop) / pipSize : null;
  const profitR = initialRiskPips && initialRiskPips > 0 ? classification.unrealizedPips / initialRiskPips : 0;
  const currentConfidence = pureIctTrade
    ? computeIctLifecycleConfidence({
        entryConfidence: entryIctConfidence,
        minutesElapsed,
        holdMinutes: expectedHoldTimeMinutes,
        lifecycleAction: ictLifecycle?.action,
        profitR,
        tpProgress: classification.tpProgress,
      })
    : liveV3Confidence?.tpHitConfidence ?? legacyCurrentConfidence;

  const remainingRR = (stopLoss != null && takeProfit != null && currentPrice !== entryPrice)
    ? Math.abs((takeProfit - currentPrice) / (currentPrice - stopLoss))
    : 1.5;
  const probs = pureIctTrade
    ? ictProbabilitiesFromConfidence(currentConfidence)
    : computeTradeProbabilities({ alignment, macro, structure, momentum, riskReward: remainingRR });
  const ictExitRecommendation = ictLifecycle?.action === 'CLOSE'
    ? 'EXIT_NOW'
    : ictLifecycle?.action === 'PARTIAL_CLOSE'
      ? 'PARTIAL_EXIT'
      : ictLifecycle?.action === 'TIGHTEN_STOP'
        ? 'HOLD_WITH_CAUTION'
        : 'HOLD';
  const ictTradeState = ictLifecycle?.action === 'CLOSE'
    ? 'REVERSAL_RISK'
    : ictLifecycle?.pastHold && ictLifecycle?.action !== 'HOLD'
      ? 'MANAGEMENT_DUE'
      : 'THESIS_ACTIVE';
`;
monitor = replaceRequired(
  monitor,
  /  const pureV3Trade = false; \/\/ V3 trades returned before foreign analysis[\s\S]*?  const probs = computeTradeProbabilities\(\{\n    alignment, macro, structure, momentum, riskReward: remainingRR,\n  \}\);\n/,
  monitorConfidenceBlock,
  'open monitor confidence block',
);
monitor = monitor.replace(
  '    tradeState: pureV3Trade ? liveV3Confidence.state : classification.tradeState,',
  '    tradeState: pureIctTrade ? ictTradeState : pureV3Trade ? liveV3Confidence.state : classification.tradeState,',
);
monitor = monitor.replace(
  '    exitRecommendation: pureV3Trade ? liveV3Confidence.exitRecommendation : classification.exitRecommendation,',
  '    exitRecommendation: pureIctTrade ? ictExitRecommendation : pureV3Trade ? liveV3Confidence.exitRecommendation : classification.exitRecommendation,',
);
monitor = monitor.replace(
  `    exitReason: pureV3Trade
      ? \`V3 live TP-hit confidence \${liveV3Confidence.tpHitConfidence}% (\${liveV3Confidence.state})\`
      : classification.exitReason,`,
  `    exitReason: pureIctTrade
      ? (ictLifecycle?.reasons || ['ICT entry thesis remains active.']).join(' ')
      : pureV3Trade
        ? \`V3 live TP-hit confidence \${liveV3Confidence.tpHitConfidence}% (\${liveV3Confidence.state})\`
        : classification.exitReason,`,
);
monitor = monitor.replace(
  '    confidenceModel: pureV3Trade ? \'v3_live_tp_hit\' : \'legacy_mtf\',',
  "    confidenceModel: pureIctTrade ? 'ict_target_hit_lifecycle' : pureV3Trade ? 'v3_live_tp_hit' : 'legacy_mtf',",
);
monitor = monitor.replace(
  '    liveTpConfidence: liveV3Confidence,',
  '    liveTpConfidence: liveV3Confidence,\n    entryIctConfidence,\n    expectedHoldTimeMinutes,\n    ictLifecycle,',
);
fs.writeFileSync(MONITOR, monitor);

// ── Reassessment card: suppress generic legacy advice for ICT positions ───────
let reassessor = fs.readFileSync(REASSESSOR, 'utf8');
reassessor = insertAfter(
  reassessor,
  `  const lifecycleRecommendation = buildMarketAlignedRecommendation({
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
`,
  `  if (pureIctTrade && ictLifecycle) {
    const actionMap = {
      CLOSE: 'close', PARTIAL_CLOSE: 'partial_close', MOVE_BREAKEVEN: 'tighten_sl',
      TIGHTEN_STOP: 'tighten_sl', HOLD: 'hold',
    };
    const ictAction = actionMap[ictLifecycle.action] || 'hold';
    lifecycleRecommendation.action = ictAction;
    lifecycleRecommendation.urgency = ictLifecycle.action === 'CLOSE'
      ? 'high'
      : ictLifecycle.action === 'HOLD' ? 'low' : 'medium';
    lifecycleRecommendation.confidence = currentConfidence;
    lifecycleRecommendation.reason = (ictLifecycle.reasons || ['ICT entry thesis remains active.']).join(' ');
    lifecycleRecommendation.unifiedSummary = lifecycleRecommendation.reason;
    lifecycleRecommendation.source = 'ict_target_hit_lifecycle';
    lifecycleRecommendation.shouldAutoClose = false;
    lifecycleRecommendation.autoCloseCandidate = ictLifecycle.action === 'CLOSE';
    lifecycleRecommendation.autoCloseReviewTriggered = ictLifecycle.action === 'CLOSE';
    lifecycleRecommendation.confidenceBelowThreshold = currentConfidence < confidenceReviewThreshold;
    lifecycleRecommendation.signalMisaligned = ictLifecycle.action === 'CLOSE';
    lifecycleRecommendation.signalMisalignmentReasons = ictLifecycle.action === 'CLOSE' ? ictLifecycle.reasons : [];
  }
`,
  'ICT reassessment recommendation override',
);
reassessor = reassessor.replace(
  '    signalMisaligned: lifecycleRecommendation.signalMisaligned,\n    signalMisalignmentReasons,',
  '    signalMisaligned: lifecycleRecommendation.signalMisaligned,\n    signalMisalignmentReasons: pureIctTrade ? (lifecycleRecommendation.signalMisalignmentReasons || []) : signalMisalignmentReasons,',
);
fs.writeFileSync(REASSESSOR, reassessor);

console.log('ICT confidence aligned: current-entry target-hit score, late-entry hard gates, final bid/ask confirmation, and one lifecycle model across signal/open/reassess.');
