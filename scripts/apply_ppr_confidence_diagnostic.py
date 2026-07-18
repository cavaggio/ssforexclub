#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PPR_ENGINE = ROOT / 'server' / 'pprEngine.js'
TRADE = ROOT / 'server' / 'oandaTrade.js'


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise RuntimeError(f'PPR diagnostic-confidence marker missing: {label}')
    return text.replace(old, new, 1)


# Keep the PPR confidence rating in scan payloads, dashboards and logs, but never
# allow it to qualify/reject a setup. PPR qualification remains the binary native
# contract: EMA9 bias/alignment, session, volume, manipulation freshness,
# rejection candle, spread, stop geometry, liquidity target and minimum R:R.
engine = PPR_ENGINE.read_text(encoding='utf-8')
engine = replace_once(
    engine,
    """  if (confidence < config.minConfidence) {
    return {
      status: 'hot',
      reason: `PPR confidence ${confidence}% is below ${config.minConfidence}%`,
      ...resultBase,
      pricing,
      direction,
      entry,
      stopLoss,
      takeProfit,
      rr,
      confidence,
      spreadPips: pricing.spreadPips,
      liquidityTarget: target,
      ...evidence,
    };
  }

""",
    """  const confidenceDiagnostic = {
    rating: confidence,
    referenceFloor: config.minConfidence,
    meetsReferenceFloor: confidence >= config.minConfidence,
    policy: 'diagnostic_only',
    affectsQualification: false,
    affectsExecution: false,
    affectsPositionSizing: false,
  };

""",
    'PPR scanner confidence gate removal',
)
engine = replace_once(
    engine,
    """    score: Math.max(8, Math.round(confidence / 5)),
    confidence,
    entryQualityConfidence: confidence,
""",
    """    score: Math.max(8, Math.round(confidence / 5)),
    scorePolicy: 'diagnostic_only',
    confidence,
    entryQualityConfidence: confidence,
    confidencePolicy: 'diagnostic_only',
    confidenceDiagnostic,
""",
    'PPR confidence diagnostic metadata',
)

for marker in [
    "confidencePolicy: 'diagnostic_only'",
    "policy: 'diagnostic_only'",
    'affectsQualification: false',
    'affectsExecution: false',
    'affectsPositionSizing: false',
]:
    if marker not in engine:
        raise RuntimeError(f'PPR confidence diagnostic integration incomplete: missing {marker}')
if 'if (confidence < config.minConfidence)' in engine:
    raise RuntimeError('PPR confidence still affects scanner qualification')
PPR_ENGINE.write_text(engine, encoding='utf-8')


# The shared OANDA executor remains responsible for broker and account safety,
# but PPR confidence and its derived score must not affect execution or sizing.
# PPR receives the configured minimum risk budget; all hard per-trade, margin,
# drawdown, daily-loss, open-risk, spread, duplicate and R:R caps still apply.
trade = TRADE.read_text(encoding='utf-8')
trade = replace_once(
    trade,
    """  if (score < MIN_SCORE) {
    return blocked(`Score ${score} < minimum ${MIN_SCORE}`);
  }
""",
    """  if (!purePprExecution && score < MIN_SCORE) {
    return blocked(`Score ${score} < minimum ${MIN_SCORE}`);
  }
  if (purePprExecution) {
    console.log(`[PPR_DIAGNOSTIC] ${pair} score=${score ?? 'n/a'} confidence=${confidence ?? 'n/a'}% — diagnostic only; native PPR policy owns qualification.`);
  }
""",
    'PPR score gate bypass',
)
trade = replace_once(
    trade,
    """  if (!Number.isFinite(confidence) || confidence < executionConfidenceFloor) {
    return blocked(`Entry-quality confidence ${Number.isFinite(confidence) ? confidence : 'n/a'}% < minimum ${executionConfidenceFloor}%`);
  }
""",
    """  if (!purePprExecution && (!Number.isFinite(confidence) || confidence < executionConfidenceFloor)) {
    return blocked(`Entry-quality confidence ${Number.isFinite(confidence) ? confidence : 'n/a'}% < minimum ${executionConfidenceFloor}%`);
  }
""",
    'PPR executor confidence gate bypass',
)
trade = replace_once(
    trade,
    """  if (autoAi) {
    const confCheck = checkAutoExecutionConfidence(confidence);
    if (!confCheck.passed) return blocked(confCheck.reason);
  }
""",
    """  if (autoAi && !purePprExecution) {
    const confCheck = checkAutoExecutionConfidence(confidence);
    if (!confCheck.passed) return blocked(confCheck.reason);
  }
""",
    'PPR autonomous confidence gate bypass',
)
trade = replace_once(
    trade,
    """  const dynamicRisk = computeDynamicTradeRisk({
    accountBalanceUSD: balanceUSD,
    confidence: signal.confidence,
    score: signal.score,
    minConfidence: MIN_CONFIDENCE,
    spreadPips: signal.spreadPips,
    maxSpreadPips: maxSpread,
    volatilityState: signal.volatilityState,
  });
""",
    """  const riskSizingConfidence = purePprExecution ? MIN_CONFIDENCE : signal.confidence;
  const riskSizingScore = purePprExecution ? null : signal.score;
  const dynamicRisk = computeDynamicTradeRisk({
    accountBalanceUSD: balanceUSD,
    confidence: riskSizingConfidence,
    score: riskSizingScore,
    minConfidence: MIN_CONFIDENCE,
    spreadPips: signal.spreadPips,
    maxSpreadPips: maxSpread,
    volatilityState: signal.volatilityState,
  });
  if (purePprExecution && dynamicRisk.allowed) {
    dynamicRisk.factors = {
      ...(dynamicRisk.factors || {}),
      policy: 'ppr_fixed_min_risk_confidence_diagnostic_only',
      diagnosticConfidence: Number.isFinite(Number(signal.confidence)) ? Number(signal.confidence) : null,
      diagnosticScore: Number.isFinite(Number(signal.score)) ? Number(signal.score) : null,
      confidenceAffectedExecution: false,
      confidenceAffectedSizing: false,
    };
  }
""",
    'PPR confidence-neutral position sizing',
)

required_trade = [
    'if (!purePprExecution && score < MIN_SCORE)',
    'if (!purePprExecution && (!Number.isFinite(confidence) || confidence < executionConfidenceFloor))',
    'if (autoAi && !purePprExecution)',
    'riskSizingConfidence = purePprExecution ? MIN_CONFIDENCE : signal.confidence',
    'riskSizingScore = purePprExecution ? null : signal.score',
    "policy: 'ppr_fixed_min_risk_confidence_diagnostic_only'",
    'confidenceAffectedExecution: false',
    'confidenceAffectedSizing: false',
]
for marker in required_trade:
    if marker not in trade:
        raise RuntimeError(f'PPR executor diagnostic-confidence integration incomplete: missing {marker}')
TRADE.write_text(trade, encoding='utf-8')

print('PPR confidence converted to diagnostic-only for qualification, execution and sizing.')
