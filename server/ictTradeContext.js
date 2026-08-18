import { ICT_FAILURE_CODES } from './ictCorrectiveGate.js';

const finite = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function buildIctTradeEntryContext({ analysis = {}, brokerTradeId = null, filledAt = new Date() } = {}) {
  const timeframe = analysis.timeframeBias || {};
  const model = analysis.marketMakerModel || {};
  const authorization = analysis.entryAuthorization || model.entryAuthorization || {};
  return {
    schemaVersion: 1,
    candidateSignalId: analysis.signalId || null,
    brokerTradeId: brokerTradeId == null ? null : String(brokerTradeId),
    filledAt: filledAt instanceof Date ? filledAt.toISOString() : new Date(filledAt).toISOString(),
    direction: analysis.signal === 'buy' ? 'long' : analysis.signal === 'sell' ? 'short' : analysis.ictBias || null,
    timeframeState: {
      d1: timeframe.d1 || null,
      h4: timeframe.h4 || null,
      h1Structure: timeframe.h1 || null,
      d1H4Aligned: timeframe.d1H4Aligned === true,
    },
    h1Momentum: analysis.h1Momentum || null,
    h1Transition: analysis.h1Transition || null,
    m5Authorization: {
      ready: authorization.ready === true,
      mode: authorization.mode || 'none',
      cycleId: authorization.cycleId || null,
      reason: authorization.reason || null,
      triggerAgeBars: finite(analysis.triggerAgeBars),
      triggerCandleTime: analysis.entryCandle?.time || null,
      fresh: analysis.freshImpulse === true,
    },
    powerOfThree: {
      stage: model.stage || model.cycle?.stage || null,
      studyDate: model.studyDate || null,
      cycleId: model.cycle?.activationId || null,
    },
    htfLiquidityCondition: {
      keyLevelTap: model.keyLevelTap || model.cycle?.keyLevel || null,
      manipulation: model.cycle?.manipulation || null,
      displacement: model.cycle?.displacement || null,
    },
    correctiveGate: analysis.correctiveGate || null,
    learningAdjustment: {
      auditId: analysis.combinedLearningContext?.auditId || null,
      adjustment: finite(analysis.combinedLearningContext?.combinedAdjustment),
      reasons: analysis.combinedLearningContext?.reasons || [],
    },
  };
}

export function classifyIctTradeFailure({ entryContext = {}, realizedR = null, mfeR = null, maeR = null, exitReason = null } = {}) {
  const gate = entryContext.correctiveGate || {};
  const momentum = entryContext.h1Momentum || {};
  const trigger = entryContext.m5Authorization || {};
  const resultR = finite(realizedR);
  const bestR = finite(mfeR);
  const worstR = finite(maeR);
  const failures = new Set(Array.isArray(gate.failureCodes) ? gate.failureCodes : []);

  if (momentum.exhausted === true) failures.add(ICT_FAILURE_CODES.H1_MOMENTUM_EXHAUSTED);
  else if (Object.keys(momentum).length > 0 && momentum.aligned === false) failures.add(ICT_FAILURE_CODES.H1_ACTIVE_MOMENTUM_NOT_ALIGNED);
  if (Object.keys(trigger).length > 0 && (trigger.fresh !== true || finite(trigger.triggerAgeBars) == null || finite(trigger.triggerAgeBars) > 1)) {
    failures.add(ICT_FAILURE_CODES.STALE_M5_TRIGGER);
  }
  if (resultR != null && resultR < 0 && bestR != null && bestR < 0.25) failures.add('DIRECTION_CONFIRMATION_FAILURE');
  if (resultR != null && resultR < 0 && bestR != null && bestR >= 0.75) failures.add('PROFIT_PROTECTION_OR_EXIT_FAILURE');
  if (worstR != null && worstR <= -0.75) failures.add('HIGH_INITIAL_ADVERSE_EXCURSION');
  if (resultR != null && resultR < 0 && failures.size === 0) failures.add('UNCLASSIFIED_LOSS');

  return {
    exitReason: exitReason || (resultR == null ? 'unresolved' : resultR > 0 ? 'broker_close_profit' : resultR < 0 ? 'broker_close_loss' : 'breakeven'),
    failureReasons: [...failures],
    adjustment: {
      type: 'post_trade_outcome',
      applied: true,
      hardGatesPreserved: true,
      action: failures.size
        ? 'Retain deterministic corrective-gate rejection; add this outcome to pair/failure evidence.'
        : 'Record successful gate outcome as positive evidence without weakening hard gates.',
    },
  };
}
