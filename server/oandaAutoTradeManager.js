import { reassessActiveTrades } from './oandaActiveTradeReassessor.js';
import { closeBrokerTrade } from './oandaTrade.js';

export const AUTO_AI_ENTRY_WINDOW = {
  startMin: 2 * 60 + 15,
  endMin: 14 * 60,
};

export const AUTO_AI_MANAGEMENT_WINDOW = {
  startMin: 2 * 60 + 15,
  // Five-minute grace window ensures the final 5:00 PM ET sweep is not missed
  // when the recurring scheduler is not aligned to the wall clock.
  endMin: 17 * 60 + 5,
};

const SEVERITY_RANK = {
  low: 1,
  medium: 2,
  high: 3,
};

function normalizeSeverity(value) {
  const severity = String(value || '').trim().toLowerCase();
  return Object.hasOwn(SEVERITY_RANK, severity) ? severity : 'low';
}

export function nyTimeParts(input = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(input);

  const read = (type) => parts.find((part) => part.type === type)?.value ?? '';
  const rawHour = Number.parseInt(read('hour') || '0', 10);
  const hour = rawHour === 24 ? 0 : rawHour;
  const minute = Number.parseInt(read('minute') || '0', 10);
  const weekday = read('weekday');

  return {
    weekday,
    isWeekend: weekday === 'Sat' || weekday === 'Sun',
    hour,
    minute,
    minutesFromMidnight: hour * 60 + minute,
  };
}

export function inAutoAiEntryWindow(input = new Date()) {
  const ny = nyTimeParts(input);
  if (ny.isWeekend) return false;
  return (
    ny.minutesFromMidnight >= AUTO_AI_ENTRY_WINDOW.startMin &&
    ny.minutesFromMidnight < AUTO_AI_ENTRY_WINDOW.endMin
  );
}

export function inAutoAiManagementWindow(input = new Date()) {
  const ny = nyTimeParts(input);
  if (ny.isWeekend) return false;
  return (
    ny.minutesFromMidnight >= AUTO_AI_MANAGEMENT_WINDOW.startMin &&
    ny.minutesFromMidnight < AUTO_AI_MANAGEMENT_WINDOW.endMin
  );
}

function reversalAdjustmentDetected(plan = {}) {
  const adjustments = Array.isArray(plan?.liveTpConfidence?.adjustments)
    ? plan.liveTpConfidence.adjustments
    : [];

  return adjustments.some((item) => {
    const label = String(item?.label || '').toLowerCase();
    return (
      label.includes('reversal') ||
      label.includes('institutional flow opposes') ||
      label.includes('mtf conflict') ||
      label.includes('macro bias opposes')
    );
  });
}

/**
 * Decide whether an already-open Auto AI trade should be closed.
 *
 * The entry engine and this exit policy are intentionally separate. This policy
 * never opens a position and never weakens entry, sizing, margin, drawdown, or
 * duplicate-trade controls.
 */
export function decideAutoAiClose(plan = {}, input = new Date()) {
  const invalidationSeverity = normalizeSeverity(plan.invalidationSeverity);
  const volatilitySeverity = normalizeSeverity(plan.volatilityCollapseSeverity);
  const trendSeverity = normalizeSeverity(plan.trendWeakeningSeverity);
  const momentumStatus = String(plan.momentumStatus || '').toLowerCase();
  const marketState = String(plan.marketState || '').toUpperCase();
  const ny = nyTimeParts(input);

  if (
    plan.invalidationDetected === true &&
    SEVERITY_RANK[invalidationSeverity] >= SEVERITY_RANK.medium
  ) {
    return {
      close: true,
      category: 'reversal_risk',
      severity: invalidationSeverity,
      reason: `Reversal/invalidation risk is ${invalidationSeverity}`,
    };
  }

  if (marketState === 'REVERSAL_RISK') {
    return {
      close: true,
      category: 'reversal_risk',
      severity: 'medium',
      reason: 'Market state is REVERSAL_RISK',
    };
  }

  if (
    momentumStatus.includes('reversal') ||
    momentumStatus.includes('reversed') ||
    reversalAdjustmentDetected(plan)
  ) {
    return {
      close: true,
      category: 'reversal_risk',
      severity: 'medium',
      reason: `Active-trade momentum/flow shows reversal risk (${momentumStatus || 'live confidence reversal signal'})`,
    };
  }

  if (
    plan.volatilityCollapsed === true &&
    SEVERITY_RANK[volatilitySeverity] >= SEVERITY_RANK.medium
  ) {
    return {
      close: true,
      category: 'volatility_slowdown',
      severity: volatilitySeverity,
      reason: `Volatility slowdown is ${volatilitySeverity}; close no later than 5:00 PM ET`,
    };
  }

  if (momentumStatus.includes('decay') || momentumStatus.includes('slowing')) {
    return {
      close: true,
      category: 'volatility_slowdown',
      severity: ny.minutesFromMidnight >= 17 * 60 ? 'high' : 'medium',
      reason: `Momentum/volatility is ${momentumStatus}; close no later than 5:00 PM ET`,
    };
  }

  if (
    plan.trendWeakeningDetected === true &&
    SEVERITY_RANK[trendSeverity] >= SEVERITY_RANK.high
  ) {
    return {
      close: true,
      category: 'reversal_risk',
      severity: trendSeverity,
      reason: 'Trend weakening reached high severity',
    };
  }

  return {
    close: false,
    category: 'hold',
    severity: 'low',
    reason: 'No medium-or-higher reversal risk or material volatility slowdown',
  };
}

export async function manageAutoAiActiveTrades({
  client,
  now = new Date(),
  log = console.log,
} = {}) {
  if (!client) throw new Error('Auto AI active-trade management requires a user-scoped OANDA client');

  if (!inAutoAiManagementWindow(now)) {
    return {
      ok: true,
      skipped: true,
      reason: 'outside_active_trade_management_window',
      tradesReviewed: 0,
      closeAttempts: [],
      assessment: null,
    };
  }

  const assessment = await reassessActiveTrades({ client });
  const trades = Array.isArray(assessment?.trades) ? assessment.trades : [];
  const closeAttempts = [];

  for (const plan of trades) {
    if (!plan || plan.error || !plan.tradeId) continue;

    if (plan.autoCloseAttempted === true && plan.autoCloseResult?.ok === true) {
      closeAttempts.push({
        tradeId: plan.tradeId,
        instrument: plan.instrument,
        ok: true,
        source: 'legacy_reassessor_auto_close',
        decision: {
          close: true,
          category: 'existing_auto_close',
          severity: 'high',
          reason: 'Trade was already closed by the reassessor during this cycle',
        },
      });
      continue;
    }

    const decision = decideAutoAiClose(plan, now);
    if (!decision.close) continue;

    log(
      `[AUTO_AI_ACTIVE_TRADE_CLOSE] account=${client.accountId || 'unknown'} ` +
      `tradeId=${plan.tradeId} pair=${plan.instrument} category=${decision.category} ` +
      `severity=${decision.severity} reason="${decision.reason}"`,
    );

    const result = await closeBrokerTrade({
      tradeId: String(plan.tradeId),
      instrument: plan.instrument,
      units: 'ALL',
      client,
    });

    closeAttempts.push({
      tradeId: String(plan.tradeId),
      instrument: plan.instrument,
      ok: result?.ok === true,
      message: result?.message ?? null,
      error: result?.error ?? null,
      source: 'auto_ai_active_trade_manager',
      decision,
    });
  }

  return {
    ok: true,
    skipped: false,
    tradesReviewed: trades.length,
    closeAttempts,
    closed: closeAttempts.filter((item) => item.ok).length,
    failed: closeAttempts.filter((item) => !item.ok).length,
    assessment,
  };
}
