/**
 * src/types/forex.ts
 * TypeScript types for Signal Stack Forex.
 * Import these wherever forex data is used in the front end.
 */

export type ForexDirection = 'long' | 'short' | 'neutral';

export type TradeDuration = 'Scalp' | 'Intraday' | 'Swing';
export type VolatilityState = 'expanding' | 'normal' | 'low';

export type ForexSession =
  | 'Sydney'
  | 'Tokyo'
  | 'London'
  | 'NewYork'
  | 'London/NewYork Overlap'
  | 'Tokyo/London Overlap'
  | 'Sydney/Tokyo Overlap'
  | 'Closed';

export type MarketStructureType =
  | 'trending_bullish'
  | 'trending_bearish'
  | 'reversal_bullish'
  | 'reversal_bearish'
  | 'consolidation'
  | 'unknown';

export interface ForexScoreBreakdown {
  trend: number;
  emaAlignment: number;
  rsi: number;
  macd: number;
  atr: number;
  spread: number;
  session: number;
  /** Multi-timeframe alignment (replaces the newsRisk placeholder). */
  mtfAlignment: number;
  srProximity: number;
  candleConfirmation: number;
}

export interface SRProximity {
  nearestResistance: number;
  nearestSupport: number;
  distToResistancePips: number;
  distToSupportPips: number;
}

export interface MacdValues {
  macd: number;
  signal: number;
  histogram: number;
}

export interface MtfAlignment {
  /** Trend on H1 timeframe (primary trend). */
  h1Trend: 'bullish' | 'bearish' | 'neutral';
  /** Trend on H4 timeframe (directional bias only). */
  h4Trend: 'bullish' | 'bearish' | 'neutral';
  /** Whether H1, H4 and M15 all agree on direction. */
  allAligned: boolean;
  /** Whether H1 and H4 agree (ignoring M15). */
  htfAligned: boolean;
  /** Whether M15 is fighting the HTF trend. */
  conflicting: boolean;
  /** Whether M5 EMA alignment confirms entry direction. */
  m5EntryAligned: boolean;
}

export interface MarketStructure {
  type: MarketStructureType;
  hasHigherHighs: boolean;
  hasHigherLows: boolean;
  hasLowerHighs: boolean;
  hasLowerLows: boolean;
  hasBreakOfStructure: boolean;
  hasRejectionWick: boolean;
  isConsolidating: boolean;
  score: number; // 0-2
}

export type AssetClass = 'Forex' | 'Metal';

// ─── Multi-timeframe waterfall types ──────────────────────────────────────────

export type MacroBias = 'bullish' | 'bearish' | 'ranging';
export type ReversalRisk = 'low' | 'medium' | 'high';
export type AlignmentStatus = 'strong' | 'mixed' | 'conflicting';
export type VolatilityRegime = 'compressed' | 'normal' | 'expanded';

export interface KeyLevel {
  price: number;
  kind: 'support' | 'resistance';
}

/** LEVEL 1 — Macro Market Regime (Daily + H4). */
export interface MacroAnalysis {
  macroBias: MacroBias;
  trendStrength: number;          // 0–100
  volatilityRegime: VolatilityRegime;
  keyLevels: KeyLevel[];
  marketStructure: {
    type: string;
    hasBOS: boolean;
    hasHigherHighs: boolean;
    hasHigherLows: boolean;
    hasLowerHighs: boolean;
    hasLowerLows: boolean;
  };
  atrPips: number;
  atrPipsHistorical: number;
  macroConfidence: number;        // 0–100
  dailyTrend: 'bullish' | 'bearish' | 'neutral';
  h4Trend: 'bullish' | 'bearish' | 'neutral';
  dailyAlignment: 'aligned_bullish' | 'aligned_bearish' | 'mixed';
  h4Alignment: 'aligned_bullish' | 'aligned_bearish' | 'mixed';
  notes: string[];
}

/** LEVEL 2 — Structure Confirmation (H1 + M30). */
export interface StructureAnalysis {
  structureAligned: boolean;
  pullbackDetected: boolean;
  reversalRisk: ReversalRisk;
  continuationProbability: number;   // 0–100
  structuralConfidence: number;      // 0–100
  h1Trend: 'bullish' | 'bearish' | 'neutral';
  m30Trend: 'bullish' | 'bearish' | 'neutral';
  h1Alignment: 'aligned_bullish' | 'aligned_bearish' | 'mixed';
  m30Alignment: 'aligned_bullish' | 'aligned_bearish' | 'mixed';
  nearKeyLevel: null | { kind: 'support' | 'resistance'; distancePips: number; price: number };
  notes: string[];
}

/** LEVEL 3 — Momentum & Execution (M15 + M5). */
export interface MomentumAnalysis {
  executionSignal: 'long' | 'short' | null;
  entryQuality: number;           // 0–100
  momentumStrength: number;       // 0–100
  executionConfidence: number;    // 0–100
  timingScore: number;            // 0–100
  candleConfirmation: 'bullish' | 'bearish' | 'doji' | 'unknown';
  m15Trend: 'bullish' | 'bearish' | 'neutral';
  m5Trend: 'bullish' | 'bearish' | 'neutral';
  m15Alignment: 'aligned_bullish' | 'aligned_bearish' | 'mixed';
  m5Alignment: 'aligned_bullish' | 'aligned_bearish' | 'mixed';
  rsi: number | null;
  macd: MacdValues | null;
  atrPips: number;
  srProximity: SRProximity | null;
  notes: string[];
}

/** Dynamic trade lifecycle output (SL/TP/hold/probabilities). */
export interface TradeLifecycle {
  sl: {
    allowed: boolean;
    rejectionReason?: string | null;
    stopLossPips: number;
    stopLossPrice: number;
    invalidationReason: string;
    structureBasedStop: number | null;
    volatilityBufferPips: number;
    atrMultiple: number | null;
  };
  tp: {
    allowed: boolean;
    rejectionReason?: string | null;
    takeProfitPips: number;
    takeProfitPrice: number;
    riskReward: number;
    targetReason: string;
    rrMultipliers: string[];
    cappedByKeyLevel: boolean;
    cappedByAtr: boolean;
    keyLevelDistance: number | null;
  };
  hold: {
    minMinutes: number;
    maxMinutes: number;
    holdConfidence: number;
    avgRangePips?: number;
    pipsPerMinute?: number;
    timeToTPReason: string;
  };
  probs: {
    tpProbability: number;
    slProbability: number;
  };
  momentumPersistence: number;
  volatilityPersistence: 'low' | 'normal' | 'high';
}

export type TradeState =
  | 'OPEN_HEALTHY'
  | 'ACCELERATING'
  | 'STALLING'
  | 'WEAKENING'
  | 'REVERSAL_RISK'
  | 'TP_LIKELY'
  | 'EXIT_RECOMMENDED'
  | 'INVALIDATED';

export type ExitRecommendation =
  | 'HOLD'
  | 'HOLD_WITH_CAUTION'
  | 'MOVE_STOP_TO_BREAKEVEN'
  | 'TRAIL_STOP'
  | 'TAKE_PARTIAL_PROFIT'
  | 'CLOSE_TRADE'
  | 'CLOSE_IMMEDIATELY';

/** Active-trade analysis payload from /api/oanda/active-trades/analysis */
export interface ActiveTradeAnalysis {
  tradeId: string;
  instrument: string;
  side: 'long' | 'short';
  units: number;
  entryPrice: number;
  currentPrice: number;
  openTime: string;
  minutesElapsed: number;
  unrealizedPL: number;
  unrealizedPips: number;
  stopLoss: number | null;
  takeProfit: number | null;
  distanceToTPPips: number;
  distanceToSLPips: number;
  tpProgress: number;
  currentAlignmentScore: number;
  currentConfidence: number;
  tradeState: TradeState;
  exitRecommendation: ExitRecommendation;
  exitReason: string;
  timeDecayRisk: 'low' | 'medium' | 'high';
  updatedHoldWindow: { minMinutes: number; maxMinutes: number; holdConfidence: number };
  tpProbability: number;
  slProbability: number;
  macroOpposes: boolean;
  conflictingTfCount: number;
  alignmentDropped: boolean;
  waterfall: {
    macro: MacroAnalysis;
    structure: StructureAnalysis;
    momentum: MomentumAnalysis;
    alignment: AlignmentResult;
  };
  error?: string;
}

export interface ActiveTradesResponse {
  trades: ActiveTradeAnalysis[];
  meta: {
    scannedAt: string;
    session: string;
    totalActive: number;
    stateCounts?: Record<string, number>;
    autoCloseEnabled?: boolean;
    notice?: string;
  };
}

// ─── Entry-quality layer types ────────────────────────────────────────────────

/** Fibonacci retracement analysis (server/oandaFibonacci.js). */
export interface FibonacciAnalysis {
  enabled: boolean;
  timeframeUsed: 'H4' | 'H1' | null;
  swingHigh?: number;
  swingLow?: number;
  impulsePips?: number;
  impulseAtrMultiple?: number | null;
  retracementLevels?: {
    level382: number;
    level500: number;
    level618: number;
    level786: number;
  };
  currentPrice?: number;
  entryZone?: { lower: number; upper: number };
  entryZoneStatus:
    | 'inside_zone'
    | 'too_early'
    | 'extended'
    | 'breakout_confirmed'
    | 'invalidated'
    | 'unknown';
  pctRetraced?: number | null;
  breakoutConfirmed?: boolean;
  reason: string;
}

export type InstitutionalFlowType =
  | 'liquidity_sweep'
  | 'break_of_structure'
  | 'choch'
  | 'range_breakout'
  | 'retest'
  | 'imbalance'
  | 'wick_rejection'
  | 'atr_expansion'
  | 'none';

export interface InstitutionalFlowSignal {
  type: InstitutionalFlowType;
  direction: 'bullish' | 'bearish' | 'neutral';
  timeframe: 'M15' | 'H1' | 'H4';
  reason: string;
  [extra: string]: unknown;
}

/** Institutional order-flow proxy (server/oandaInstitutionalFlow.js). */
export interface InstitutionalFlow {
  detected: boolean;
  type: InstitutionalFlowType;
  direction: 'bullish' | 'bearish' | 'neutral';
  confidenceImpact: number;
  reason: string;
  signals: InstitutionalFlowSignal[];
  net?: number;
}

export interface ForexNewsEvent {
  time: string;
  epoch: number;
  currency: string;
  impact: 'high' | 'medium' | 'low' | string;
  impactRank: number;
  title: string;
  actual: unknown;
  forecast: unknown;
  previous: unknown;
  minutesUntil?: number;
  minutesAgo?: number;
}

/** News-risk envelope (server/oandaNewsRisk.js). */
export interface ForexNewsRisk {
  pair: string;
  enabled: boolean;
  blocked: boolean;
  riskLevel: 'low' | 'medium' | 'high';
  matchingCurrencies: string[];
  upcomingEvents: ForexNewsEvent[];
  recentEvents: ForexNewsEvent[];
  postNewsConfirmationRequired: boolean;
  reason: string;
  provider?: { source: string | null; warning: string | null };
  config?: {
    highImpactBlockMinutes: number;
    mediumImpactCautionMinutes: number;
    postNewsConfirmationMinutes: number;
  };
}

/** Entry-timing classification (server/oandaEntryTiming.js). */
export interface EntryTiming {
  status: 'valid_entry' | 'too_early' | 'late_entry' | 'wait_for_retest' | 'news_blocked';
  reason: string;
  suggestedEntryZone: { lower: number; upper: number } | null;
  invalidationLevel: number | null;
  confirmationNeeded: string | null;
  factors: {
    fib: string;
    flow: string;
    flowType: string;
    news: string;
    structureType: string | null;
    reversalRisk: 'low' | 'medium' | 'high';
    postNewsConfirm: boolean;
  };
}

/** Structure-aware stop-loss audit (server/oandaTradeLifecycle.js). */
export interface StopLossAnalysis {
  structureLevel: number | null;
  structureSource:
    | 'm15_swing'
    | 'h1_swing'
    | 'liquidity_sweep'
    | 'fib_impulse_origin'
    | 'atr_fallback'
    | null;
  atrBuffer: number;
  finalStopLoss: number;
  candidatesConsidered: Array<{
    source: string;
    rawLevel: number;
    distancePips: number;
  }>;
  reason: string;
}

/** Alignment engine output. */
export interface AlignmentResult {
  timeframeAlignmentScore: number;       // 0–100
  alignmentStatus: AlignmentStatus;
  dominantBias: MacroBias;
  conflictingTimeframes: string[];
  tradeQualified: boolean;
  rejectionReasons: string[];
  timeframes: {
    daily: 'bullish' | 'bearish' | 'neutral';
    h4:    'bullish' | 'bearish' | 'neutral';
    h1:    'bullish' | 'bearish' | 'neutral';
    m30:   'bullish' | 'bearish' | 'neutral';
    m15:   'bullish' | 'bearish' | 'neutral';
    m5:    'bullish' | 'bearish' | 'neutral';
  };
  weights: Record<string, number>;
  directional: number;
  minimums: {
    minMacroConfidence: number;
    minStructuralConfidence: number;
    minExecutionConfidence: number;
    minAlignmentScore: number;
    minRiskReward: number;
  };
}

export type RRTier = 'reject' | 'standard' | 'preferred' | 'premium';

export interface ForexSignal {
  pair: string;
  /** Human-readable name: "Euro / US Dollar", "Gold", "Silver", etc. */
  instrumentName: string;
  /** Asset class for display and routing logic. */
  assetClass: AssetClass;
  direction: ForexDirection;
  score: number;
  confidence: number;
  /** Signal Stack V3 — expected-R qualification (per-signal). */
  expectedRiskPips?:   number;
  expectedRewardPips?: number;
  expectedRR?:         number;
  rrTier?:             RRTier;
  rrQualityFactor?:    number;
  entry: number;
  stopLoss: number;
  /** Stop-loss distance in pips — always 20 under the fixed 1:3 price structure. */
  stopLossPips: number;
  takeProfit: number;
  /** Risk/reward ratio — always 3 under the fixed 1:3 price structure. */
  riskReward: number;
  spreadPips: number;
  session: ForexSession;
  /** Lot size computed per trade from the dynamic USD risk budget. */
  lotSize: number;
  /** OANDA units for this trade — base currency amount, signed by direction. */
  tradeUnits: number;
  /** Approximate notional value traded (units × entry, corrected per pair). */
  amountTraded: number;
  /** Per-trade risk % of account balance — driven by confidence/score/spread/volatility. */
  riskPercent: number;
  /** Active risk mode. */
  riskMode?: 'dynamic' | 'fixed_dollar';
  /** USD risk budget for this trade (balance × riskPercent / 100, then capped). */
  targetRiskUSD?: number;
  /** Actual dollar loss at the stop after broker-unit rounding. */
  actualRiskUSD?: number;
  /** Target dollar reward at the take-profit (~targetRiskUSD × minimumRiskReward). */
  estimatedRewardUSD?: number;
  /** Minimum risk-reward target (TP distance multiplier of SL distance). */
  minimumRiskReward?: number;
  /** Inputs that drove the per-trade risk %, for transparency on the card. */
  riskSizingFactors?: {
    confidence?: number;
    score?: number;
    spreadPips?: number | null;
    maxSpreadPips?: number | null;
    volatilityState?: string | null;
    confidenceInterpolant?: number;
    modifiers?: string[];
  };
  /** Take-profit distance in pips — always 60 under the fixed 1:3 price structure. */
  takeProfitPips?: number;
  /** USD notional exposure (units × entry, corrected for pair quote currency). */
  notionalUSD?: number;
  /** Margin OANDA is expected to reserve for this trade in USD. */
  estimatedMarginRequired?: number;
  /** Effective leverage used for margin estimation (e.g. 50 for 50:1). */
  effectiveLeverage?: number;
  /** USD P&L per pip on a 1-standard-lot position. */
  pipValuePerStandardLot?: number;
  /** Inline warnings produced by the sizing routine. */
  sizingWarnings?: string[];
  /** Risk-mode banner text. */
  aggressiveRiskWarning?: string;
  /** Dynamic SL/TP/hold-window/probability bundle from the lifecycle engine. */
  lifecycle?: TradeLifecycle;
  /** Plain-English reason for the dynamic TP (mirror of lifecycle.tp.targetReason). */
  targetReason?: string;
  /** Plain-English reason for the dynamic SL (mirror of lifecycle.sl.invalidationReason). */
  invalidationReason?: string;
  cappedByKeyLevel?: boolean;
  cappedByAtr?: boolean;
  keyLevelDistance?: number | null;
  tpProbability?: number;
  slProbability?: number;
  holdWindowMinMinutes?: number;
  holdWindowMaxMinutes?: number;
  holdConfidence?: number;
  /** Layer 1 — Daily + H4 macro analysis. */
  macro?: MacroAnalysis;
  /** Layer 2 — H1 + M30 structure analysis. */
  structure?: StructureAnalysis;
  /** Layer 3 — M15 + M5 momentum / execution analysis. */
  momentum?: MomentumAnalysis;
  /** Alignment-engine output. */
  alignment?: AlignmentResult;
  /** Fibonacci retracement of the most recent H1/H4 impulse. */
  fibonacci?: FibonacciAnalysis;
  /** Institutional order-flow proxy (sweep / BOS / CHoCH / range / retest / FVG). */
  institutionalFlow?: InstitutionalFlow;
  /** Forex news-risk envelope for this pair's currencies. */
  newsRisk?: ForexNewsRisk;
  /** Composite entry-timing classification — gates execution. */
  entryTiming?: EntryTiming;
  /** Structure-aware stop-loss placement audit (mirror of lifecycle.sl.stopLossAnalysis). */
  stopLossAnalysis?: StopLossAnalysis;
  /** Intraday duration label: Scalp (<30m), Intraday (30m–3h), Swing (>3h). */
  timeframeEstimate: string;
  /** Typed trade duration classification. */
  tradeDuration: TradeDuration;
  /** Estimated hold time in minutes (20 scalp / 90 intraday / 240 swing). */
  estimatedHoldMinutes: number;
  /** Current volatility state derived from ATR. */
  volatilityState: VolatilityState;
  /** Trend strength 0–100 (EMA alignment + market structure + MTF). */
  trendStrength: number;
  /** Momentum score 0–100 (RSI + MACD + M5 entry timing + ATR). */
  momentumScore: number;
  /** Expected price movement in pips (ATR × duration multiplier). */
  expectedMovementPips: number | null;
  /** True when M15 direction opposes market structure (bearish structure on a long, or bullish on a short). */
  directionalConflict: boolean;
  rsi: number | null;
  macd: MacdValues | null;
  atrPips: number | null;
  trend: 'bullish' | 'bearish' | 'neutral';
  emaAlignment: 'aligned_bullish' | 'aligned_bearish' | 'mixed';
  candleConfirmation: 'bullish' | 'bearish' | 'doji' | 'unknown';
  srProximity: SRProximity | null;
  scoreBreakdown: ForexScoreBreakdown;
  /** Multi-timeframe alignment data (H1, H4). */
  mtfAlignment: MtfAlignment | null;
  /** Market structure classification. */
  marketStructure: MarketStructure | null;
  /** Historical win rate for this pair+session (null if < 3 trades). */
  historicalWinRate: number | null;
  generatedAt: string;
}

export interface ForexRejected {
  pair: string;
  direction?: ForexDirection | null;
  score?: number;
  confidence?: number;
  reason: string;
  /** Complete list of reasons the waterfall rejected the trade. */
  rejectionReasons?: string[];
  spreadPips?: number;
  session?: string;
  rsi?: number | null;
  trend?: string;
  alignment?: AlignmentResult | string;
  scoreBreakdown?: Partial<ForexScoreBreakdown>;
  mtfAlignment?: MtfAlignment | null;
  marketStructure?: MarketStructure | null;
  /** Waterfall layers attached when rejection happened mid-waterfall. */
  macro?: MacroAnalysis;
  structure?: StructureAnalysis;
  momentum?: MomentumAnalysis;
  /** Entry-quality layer (attached to rejected signals for dashboard visibility). */
  fibonacci?: FibonacciAnalysis;
  institutionalFlow?: InstitutionalFlow;
  newsRisk?: ForexNewsRisk;
  entryTiming?: EntryTiming;
  /** Rejection category — extended set: news_blocked | flow_opposes added. */
  rejectionCategory?:
    | 'no_setup'
    | 'weak_setup'
    | 'conflicting_setup'
    | 'risk_filter'
    | 'news_blocked'
    | 'flow_opposes';
}

export interface ForexScanMeta {
  scannedAt: string;
  session: string;
  pairsScanned: number;
  totalQualified: number;
  totalRejected: number;
  minScore?: number;            // legacy — replaced by minAlignmentScore
  minConfidence: number;
  minAlignmentScore?: number;
  maxSpreadPips: number;
  metalsMaxSpreadPips?: number;
  /** Ordered list of pairs scanned (ranked by quality). */
  pairRankOrder: string[];
  /** Active watchlist (from FOREX_WATCHLIST env or default). */
  watchlist: string[];
  /** Default display lot size (sidebar fallback only — never used to size live trades). */
  defaultDisplayLotSize?: number;
  /** Legacy field — replaced by defaultDisplayLotSize. Kept for backward compat. */
  fixedLotSize?: number;
  /** Active risk mode label. */
  riskMode?: 'dynamic' | 'fixed_dollar';
  /** Minimum per-trade risk % of balance (floor). */
  minRiskPercent?: number;
  /** Maximum per-trade risk % of balance (ceiling). */
  maxRiskPercent?: number;
  /** Confidence threshold at which trades are sized to maxRiskPercent. */
  confidenceForMaxRisk?: number;
  /** Live account balance used to convert risk % → USD on this scan. */
  accountBalanceUSD?: number | null;
  /** Risk-reward ratio used for every trade (3 under the fixed 1:3 structure). */
  minimumRiskReward?: number;
  /** Risk-reward ratio used for every trade (alias of minimumRiskReward). */
  riskReward?: number;
  /** Fixed stop-loss distance in pips (20 under the fixed 1:3 structure). */
  stopLossPips?: number;
  /** Fixed take-profit distance in pips (60 under the fixed 1:3 structure). */
  takeProfitPips?: number;
  /** Risk-mode banner text. */
  aggressiveRiskWarning?: string;
  /** 'hybrid' (default) or 'strict' — entry-timing gate mode. */
  entryTimingMode?: 'hybrid' | 'strict';
  /** Whether the forex news-risk filter is active. */
  newsFilterEnabled?: boolean;
  newsHighImpactBlockMinutes?: number;
  newsMediumImpactCautionMinutes?: number;
  postNewsConfirmationMinutes?: number;
}

export interface ForexScanResult {
  qualified: ForexSignal[];
  rejected: ForexRejected[];
  meta: ForexScanMeta;
}

export interface OandaDiagnostics {
  timestamp: string;
  env: 'practice' | 'live';
  baseUrl: string | null;
  apiKeySet: boolean;
  accountIdSet: boolean;
  connectionOk: boolean;
  accountReachable: boolean;
  accountBalance: number | null;
  accountCurrency: string | null;
  error: string | null;
}

export interface ForexTradeState {
  autoTradeEnabled: boolean;
  dailyTradesCount: number;
  dailyTradesCap: number;
  dailyLossUSD: number;
  activeTrades: string[];
  cooldownRemainingMs: number;
}

export type ExecutionState =
  | 'SUBMITTED'
  | 'FILLED'
  | 'SL_ATTACHED'
  | 'TP_ATTACHED'
  | 'CANCELLED'
  | 'REJECTED';

export interface ExecutionLogEntry {
  phase: string;
  timestamp: string;
  tradeId?: string;
  fillPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  marginRequired?: number;
  cancelReason?: string;
  rejectReason?: string;
  error?: string;
  transaction?: Record<string, unknown>;
}

export interface ForexTradeResult {
  success: boolean;
  blocked: boolean;
  reason: string | null;
  /** Final execution state after all phases complete. */
  executionState?: ExecutionState;
  /** OANDA trade ID assigned on fill. */
  tradeId?: string;
  /** Actual fill price from orderFillTransaction. */
  fillPrice?: number;
  /** Exact OANDA cancel reason (from orderCancelTransaction.reason). */
  cancelReason?: string;
  /** Reject reason when no fill transaction was returned. */
  rejectReason?: string;
  /** USD notional value of the trade (corrected for pair type). */
  notionalUSD?: number;
  /** Actual margin reserved by OANDA for this trade (from fill transaction). */
  marginRequired?: number;
  /** Free margin available before the trade was placed. */
  marginAvailable?: number;
  /** Projected free margin after the trade (marginAvailable − estimatedMargin). */
  projectedFreeMargin?: number;
  /** Effective leverage used for margin estimation (e.g. 50 for 50:1). */
  leverage?: number;
  /** Ordered log of each execution phase with transaction details. */
  executionLog?: ExecutionLogEntry[];
  oandaResponse?: unknown;
  units?: number;
  riskAmount?: number;
  tradeHistoryId?: string;
  /** Sizing breakdown used for the order. */
  sizing?: {
    riskMode: 'dynamic' | 'fixed_dollar';
    targetRiskUSD: number;
    actualRiskUSD: number;
    estimatedRewardUSD: number;
    minimumRiskReward: number;
    stopLossPips: number;
    takeProfitPips: number;
    tradeUnits: number;
    lotSize: number;
    pipValuePerStandardLot: number;
    notionalUSD: number;
    estimatedMarginRequired: number;
    effectiveLeverage: number;
    warnings: string[];
  };
  /** Banner text for the temporary aggressive mode. */
  aggressiveRiskWarning?: string;
}

// ─── Trade history ────────────────────────────────────────────────────────────

export interface TradeHistoryEntry {
  id: string;
  timestamp: string;
  pair: string;
  direction: ForexDirection;
  session: string;
  timeframe: string;
  score: number;
  confidence: number;
  scoreBreakdown: Partial<ForexScoreBreakdown>;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  atrPips: number | null;
  trend: string | null;
  mtfAlignment: MtfAlignment | null;
  marketStructure: MarketStructure | null;
  units: number;
  riskAmount: number;
  result: 'win' | 'loss' | 'pending' | 'manual_close';
  pnl: number | null;
  durationMinutes: number | null;
  oandaOrderId: string | null;
}

export interface PerformanceStat {
  pair: string;
  session: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  expectancy: number | null;
  totalPnl: number;
  avgScore: number;
}
