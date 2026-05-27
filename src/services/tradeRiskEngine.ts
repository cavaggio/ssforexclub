// ── Trade Risk Engine ─────────────────────────────────────────────────────────
// Final gatekeeper before any Alpaca order submission.
//
// ARCHITECTURE RULE:
//   Signal Stack scores → Claude advises → Risk Engine gates → Alpaca executes
//
// This engine's hard rules are FINAL. Claude can only block a trade;
// it cannot override a failed risk rule. If Claude says APPROVE but a
// hard rule fails, the trade is blocked.

import { RISK_CONFIG, isWithinTradingWindow } from './alpacaLiveTrading';
import type { TradeSignal, LiveAccount, LivePosition, LiveOrder, RiskState } from './alpacaLiveTrading';
import type { ClaudeTradeEvaluation, AdvisoryDecision } from './claudeAdvisor';

// ── Types ─────────────────────────────────────────────────────────────────────

export type RuleResult = {
  rule: string;
  pass: boolean;
  value: string;
  category: 'signal' | 'account' | 'risk' | 'timing' | 'claude';
};

export type RiskDecision = {
  approved: boolean;
  blockedReason?: string;
  rules: RuleResult[];
  signalStackPassed: boolean;
  claudeDecision: AdvisoryDecision | 'NOT_RUN';
  claudeBlocked: boolean;
  riskEngineBlocked: boolean;
  canExecute: boolean;
};

export type ExecutionGate = {
  signalStackPassed: boolean;
  claudeApproved: boolean;
  riskDecisionApproved: boolean;
  liveTradingEnabled: boolean;
  autoTradeEnabled: boolean;
  shadowModeOff: boolean;
  liveAutoTradeConfirmed: boolean;
  canExecute: boolean;
  blockedReasons: string[];
};

// ── Core risk evaluation ──────────────────────────────────────────────────────

export const tradeRiskEngine = {

  /**
   * Evaluate all hard risk rules for a given signal + account state.
   * Claude's advisory is incorporated but cannot override hard rules.
   *
   * Returns a full RiskDecision with per-rule results and final approval.
   */
  evaluate(
    signal: TradeSignal,
    account: LiveAccount,
    riskState: RiskState,
    positions: LivePosition[],
    orders: LiveOrder[],
    claudeEvaluation: ClaudeTradeEvaluation | null,
  ): RiskDecision {

    const rules: RuleResult[] = [
      // ── Signal Stack rules ───────────────────────────────────────────
      {
        rule:     'Signal score ≥ 14',
        pass:     signal.totalScore >= RISK_CONFIG.MIN_SCORE,
        value:    `${signal.totalScore}/20`,
        category: 'signal',
      },
      {
        rule:     'Confidence ≥ 65%',
        pass:     signal.confidence >= RISK_CONFIG.MIN_CONFIDENCE,
        value:    `${signal.confidence}%`,
        category: 'signal',
      },
      {
        rule:     'Risk/Reward ≥ 2',
        pass:     signal.riskReward >= RISK_CONFIG.MIN_RISK_REWARD,
        value:    `1:${signal.riskReward}`,
        category: 'signal',
      },
      {
        rule:     'Grade A or A+',
        pass:     signal.grade === 'A' || signal.grade === 'A+',
        value:    signal.grade,
        category: 'signal',
      },
      {
        rule:     'Market alignment not BEARISH',
        pass:     signal.marketAlignment !== 'BEARISH',
        value:    signal.marketAlignment,
        category: 'signal',
      },
      {
        rule:     'Option symbol present',
        pass:     !!signal.optionSymbol,
        value:    signal.optionSymbol || 'missing',
        category: 'signal',
      },
      {
        rule:     'Limit price > 0',
        pass:     (signal.limitPrice ?? 0) > 0,
        value:    signal.limitPrice ? `$${signal.limitPrice}` : 'missing',
        category: 'signal',
      },

      // ── Account rules ────────────────────────────────────────────────
      {
        rule:     'Account not trading-blocked',
        pass:     !account.tradingBlocked,
        value:    account.tradingBlocked ? 'BLOCKED' : 'OK',
        category: 'account',
      },
      {
        rule:     'Account not account-blocked',
        pass:     !account.accountBlocked,
        value:    account.accountBlocked ? 'BLOCKED' : 'OK',
        category: 'account',
      },
      {
        rule:     'Account status ACTIVE',
        pass:     account.status?.toUpperCase() === 'ACTIVE',
        value:    account.status || 'UNKNOWN',
        category: 'account',
      },

      // ── Daily risk limits ────────────────────────────────────────────
      {
        rule:     `Trades today < ${RISK_CONFIG.MAX_TRADES_PER_DAY}`,
        pass:     riskState.tradesToday < RISK_CONFIG.MAX_TRADES_PER_DAY,
        value:    `${riskState.tradesToday}/${RISK_CONFIG.MAX_TRADES_PER_DAY}`,
        category: 'risk',
      },
      {
        rule:     `Open positions < ${RISK_CONFIG.MAX_OPEN_POSITIONS}`,
        pass:     positions.length < RISK_CONFIG.MAX_OPEN_POSITIONS,
        value:    `${positions.length}/${RISK_CONFIG.MAX_OPEN_POSITIONS}`,
        category: 'risk',
      },
      {
        rule:     `Consecutive losses < ${RISK_CONFIG.MAX_CONSECUTIVE_LOSSES}`,
        pass:     riskState.consecutiveLosses < RISK_CONFIG.MAX_CONSECUTIVE_LOSSES,
        value:    String(riskState.consecutiveLosses),
        category: 'risk',
      },
      {
        rule:     'Daily loss limit not breached',
        pass:     !riskState.tradingDisabled || riskState.dailyTargetReached,
        value:    riskState.disableReason ?? 'OK',
        category: 'risk',
      },
      {
        rule:     'Daily profit target not reached',
        pass:     !riskState.dailyTargetReached,
        value:    riskState.dailyTargetReached ? 'REACHED' : 'OK',
        category: 'risk',
      },
      {
        rule:     'No duplicate open position',
        pass:     signal.optionSymbol?.startsWith('SIM_')
                    ? true
                    : !positions.some(p => p.symbol === signal.optionSymbol),
        value:    positions.some(p => p.symbol === signal.optionSymbol) ? 'DUPLICATE' : 'unique',
        category: 'risk',
      },
      {
        rule:     'No duplicate pending order',
        pass:     signal.optionSymbol?.startsWith('SIM_')
                    ? true
                    : !orders.some(o => o.symbol === signal.optionSymbol && ['new', 'accepted', 'pending_new'].includes(o.status)),
        value:    'checked',
        category: 'risk',
      },
      {
        rule:     'Order type is limit (no market orders)',
        pass:     true, // enforced at submission — recorded here for visibility
        value:    'limit',
        category: 'risk',
      },

      // ── Timing ───────────────────────────────────────────────────────
      {
        rule:     'Within trading window (9:35–15:55 ET)',
        pass:     isWithinTradingWindow(),
        value:    isWithinTradingWindow() ? 'IN WINDOW' : 'OUTSIDE',
        category: 'timing',
      },

      // ── Claude advisory ──────────────────────────────────────────────
      {
        rule:     'Claude advisory: not REJECT',
        pass:     claudeEvaluation ? claudeEvaluation.advisoryDecision !== 'REJECT' : true,
        value:    claudeEvaluation?.advisoryDecision ?? 'NOT_RUN',
        category: 'claude',
      },
      // CAUTION is treated as a block by default (stricter conditions not met)
      {
        rule:     'Claude advisory: not CAUTION (strict mode)',
        pass:     claudeEvaluation ? claudeEvaluation.advisoryDecision === 'APPROVE' : true,
        value:    claudeEvaluation?.advisoryDecision ?? 'NOT_RUN',
        category: 'claude',
      },
    ];

    const signalRules  = rules.filter(r => r.category === 'signal');
    const nonClaudeRules = rules.filter(r => r.category !== 'claude');

    const signalStackPassed = signalRules.every(r => r.pass);
    const hardRulesPassed   = nonClaudeRules.every(r => r.pass);

    const claudeDecision: AdvisoryDecision | 'NOT_RUN' = claudeEvaluation?.advisoryDecision ?? 'NOT_RUN';
    const claudeBlocked = claudeEvaluation
      ? claudeEvaluation.advisoryDecision !== 'APPROVE'
      : false;

    const firstFailed = rules.find(r => !r.pass);
    const approved    = hardRulesPassed && !claudeBlocked;

    return {
      approved,
      blockedReason:   firstFailed?.rule,
      rules,
      signalStackPassed,
      claudeDecision,
      claudeBlocked,
      riskEngineBlocked: !hardRulesPassed,
      canExecute: approved,
    };
  },

  /**
   * Final execution gate check combining all layers.
   * This is the definitive canExecute computation referenced in the spec:
   *
   *   canExecute =
   *     signalStackPassed
   *     && claudeEvaluation.advisoryDecision === "APPROVE"
   *     && riskDecision.approved === true
   *     && liveTradingEnabled === true
   *     && autoTradeEnabled === true
   *     && shadowMode === false
   *     && liveAutoTradeConfirmed === true
   */
  computeExecutionGate(
    riskDecision: RiskDecision,
    liveTradingEnabled: boolean,
    autoTradeEnabled: boolean,
    shadowMode: boolean,
    liveAutoTradeConfirmed: boolean,
  ): ExecutionGate {
    const blockedReasons: string[] = [];

    if (!riskDecision.signalStackPassed)   blockedReasons.push('Signal Stack rules failed');
    if (riskDecision.claudeBlocked)        blockedReasons.push(`Claude advisory: ${riskDecision.claudeDecision}`);
    if (!riskDecision.approved)            blockedReasons.push(riskDecision.blockedReason ?? 'Risk engine blocked');
    if (!liveTradingEnabled)               blockedReasons.push('Live trading not enabled');
    if (!autoTradeEnabled)                 blockedReasons.push('Auto-trade not enabled');
    if (shadowMode)                        blockedReasons.push('Shadow mode is ON');
    if (!liveAutoTradeConfirmed)           blockedReasons.push('Live auto-trade not confirmed by user');

    const canExecute =
      riskDecision.signalStackPassed &&
      riskDecision.claudeDecision === 'APPROVE' &&
      riskDecision.approved === true &&
      liveTradingEnabled === true &&
      autoTradeEnabled === true &&
      shadowMode === false &&
      liveAutoTradeConfirmed === true;

    return {
      signalStackPassed:       riskDecision.signalStackPassed,
      claudeApproved:          riskDecision.claudeDecision === 'APPROVE',
      riskDecisionApproved:    riskDecision.approved,
      liveTradingEnabled,
      autoTradeEnabled,
      shadowModeOff:           !shadowMode,
      liveAutoTradeConfirmed,
      canExecute,
      blockedReasons,
    };
  },
};
