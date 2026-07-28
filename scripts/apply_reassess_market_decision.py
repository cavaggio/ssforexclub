#!/usr/bin/env python3
"""Unify active-trade reassessment around live market evidence.

The reassessment card previously exposed several independent recommendation
systems at once. This pass keeps the existing analytics but adds one final,
authoritative decision that prioritizes thesis invalidation, current confidence,
institutional flow, MTF alignment, and the position's live P/L state.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REASSESSOR = ROOT / "server" / "oandaActiveTradeReassessor.js"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    # Later strategy-specific lifecycle passes may insert bounded logic inside
    # these generated blocks. Treat the durable markers as synchronized rather
    # than requiring the original block to remain byte-for-byte contiguous.
    if label == "authoritative final decision" and all(marker in text for marker in (
        "const lifecycleRecommendation = buildMarketAlignedRecommendation",
        "const autoCloseAnalysis = {",
    )):
        return text
    if label == "reassessment evidence payload" and all(marker in text for marker in (
        "confidenceReviewThreshold,",
        "autoCloseAnalysis,",
        "institutionalFlow: {",
        "marketMovement: {",
    )):
        return text
    if old not in text:
        raise RuntimeError(f"Reassessment decision marker missing: {label}")
    return text.replace(old, new, 1)


source = REASSESSOR.read_text(encoding="utf-8")

helper = r'''
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

'''

source = replace_once(
    source,
    "function getPipSize(pair) {",
    helper + "function getPipSize(pair) {",
    "market-aligned recommendation helper",
)

review_context = r'''
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
'''

source = replace_once(
    source,
    "  const originalSlPips = Number.isFinite(originalSL)",
    review_context + "\n  const originalSlPips = Number.isFinite(originalSL)",
    "live signal comparison context",
)

final_decision = r'''
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
'''

source = replace_once(
    source,
    "  console.log(lifecycle.logLine);\n\n  return {",
    "  console.log(lifecycle.logLine);\n" + final_decision + "\n  return {",
    "authoritative final decision",
)

source = replace_once(
    source,
    "    currentConfidence,\n    confidenceModel:",
    "    currentConfidence,\n"
    "    initialConfidence,\n"
    "    confidenceReviewThreshold,\n"
    "    confidenceBelowReviewThreshold: lifecycleRecommendation.confidenceBelowThreshold,\n"
    "    signalMisaligned: lifecycleRecommendation.signalMisaligned,\n"
    "    signalMisalignmentReasons,\n"
    "    institutionalFlow: {\n"
    "      detected: !!institutionalFlow?.detected,\n"
    "      direction: institutionalFlow?.direction || 'neutral',\n"
    "      aligned: !!flowMatchesDirection,\n"
    "      opposes: !!flowOpposes,\n"
    "      reason: institutionalFlow?.reason || null,\n"
    "      signals: Array.isArray(institutionalFlow?.signals) ? institutionalFlow.signals.slice(0, 5) : [],\n"
    "    },\n"
    "    marketMovement: {\n"
    "      currentPrice: +currentPrice.toFixed(5),\n"
    "      entryPrice: +entryPrice.toFixed(5),\n"
    "      profitPips: +profitPipsNow.toFixed(1),\n"
    "      profitR,\n"
    "      m15Trend: momentum.m15Trend || 'neutral',\n"
    "      candleStrengthScore: candleStrength.candleStrengthScore,\n"
    "      velocityScore: lifecycle.velocityScore,\n"
    "      momentumStatus: lifecycle.momentumStatus,\n"
    "    },\n"
    "    autoCloseAnalysis,\n"
    "    confidenceModel:",
    "reassessment evidence payload",
)

source = replace_once(
    source,
    "    lifecycleRecommendation: lifecycle.recommendation,",
    "    lifecycleRecommendation,",
    "final lifecycle recommendation output",
)

for marker in [
    "export function buildMarketAlignedRecommendation",
    "ACTIVE_TRADE_CLOSE_REVIEW_CONFIDENCE",
    "signalMisalignmentReasons",
    "const lifecycleRecommendation = buildMarketAlignedRecommendation",
    "autoCloseAnalysis",
    "institutionalFlow: {",
    "marketMovement: {",
    "lifecycleRecommendation,",
]:
    if marker not in source:
        raise RuntimeError(f"Reassessment decision patch incomplete: missing {marker}")

REASSESSOR.write_text(source, encoding="utf-8")
print("Active-trade reassessment now emits one market-aligned recommendation and auto-close review.")
