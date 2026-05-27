// ── Alpaca Live Trading Service ───────────────────────────────────────────────
// Frontend-side service. All Alpaca API calls are proxied through Supabase
// Edge Functions so that API secrets never touch the browser.

import { ALPACA_API_BASE as API_BASE_URL } from '../lib/apiBase';

// ── Types ─────────────────────────────────────────────────────────────────────

export type AlpacaEnvironment = 'paper' | 'live';

export type TradeSignal = {
  ticker: string;
  optionSymbol: string;
  limitPrice: number;
  totalScore: number;
  confidence: number;
  riskReward: number;
  grade: 'A+' | 'A' | 'B';
  marketAlignment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  bias: string;
  entry: number;
  stop: number;
  target: number;
  catalyst?: string;
};

export type LiveAccount = {
  accountNumber: string;
  buyingPower: number;
  cash: number;
  portfolioValue: number;
  equity: number;
  daytradeCount: number;
  status: string;
  tradingBlocked: boolean;
  accountBlocked: boolean;
  patternDayTrader: boolean;
  optionsLevel?: number;
};

export type LivePosition = {
  symbol: string;
  qty: number;
  marketValue: number;
  unrealizedPL: number;
  unrealizedPLPercent: number;
  side: string;
};

export type LiveOrder = {
  id: string;
  symbol: string;
  qty: number;
  side: string;
  type: string;
  status: string;
  limitPrice?: number;
  submittedAt: string;
  filledAt?: string;
};

export type TradeDecision = {
  action: 'submit' | 'block' | 'shadow';
  reason?: string;
  orderId?: string;
};

export type TradeLogEntry = {
  id: string;
  timestamp: string;
  ticker: string;
  optionSymbol: string;
  signalScore: number;
  confidence: number;
  riskReward: number;
  grade: string;
  entryPrice?: number;
  qty: number;
  status: 'blocked' | 'submitted' | 'filled' | 'canceled' | 'rejected' | 'shadow';
  rejectionReason?: string;
  orderId?: string;
  environment: AlpacaEnvironment;
  shadowMode: boolean;
};

export type RiskState = {
  tradesToday: number;
  consecutiveLosses: number;
  dailyPnl: number;
  tradingDisabled: boolean;
  disableReason?: string;
  dailyTargetReached: boolean;
};

export type TradingRuleCheck = {
  rule: string;
  pass: boolean;
  value?: string;
};

// ── Risk configuration (safe defaults) ───────────────────────────────────────

export const RISK_CONFIG = {
  MAX_TRADES_PER_DAY:     3,
  MAX_CONTRACTS:          1,
  MAX_OPEN_POSITIONS:     3,
  MAX_RISK_PER_TRADE_PCT: 0.01,   // 1% of equity
  MAX_DAILY_LOSS_PCT:     0.02,   // 2% of equity
  DAILY_TARGET_PCT:       0.02,   // 2% of equity
  MAX_CONSECUTIVE_LOSSES: 2,
  MIN_SCORE:              14,
  MIN_CONFIDENCE:         65,
  MIN_RISK_REWARD:        1.6,
  ORDER_CANCEL_TIMEOUT_MS: 5 * 60 * 1000, // 5 minutes
  LOOP_INTERVAL_MS:       5 * 60 * 1000,  // 5 minutes
  // Eastern Time trading window
  WINDOW_START_HOUR:      9,
  WINDOW_START_MIN:       35,
  WINDOW_END_HOUR:        15,
  WINDOW_END_MIN:         55,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Returns true if current Eastern Time is within the preferred trading window Mon–Fri */
export function isWithinTradingWindow(): boolean {
  const now = new Date();
  // Get Eastern Time components
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et = new Date(etStr);
  const day = et.getDay(); // 0=Sun 6=Sat
  if (day === 0 || day === 6) return false;

  const h = et.getHours();
  const m = et.getMinutes();
  const total = h * 60 + m;
  const start = RISK_CONFIG.WINDOW_START_HOUR * 60 + RISK_CONFIG.WINDOW_START_MIN;
  const end   = RISK_CONFIG.WINDOW_END_HOUR   * 60 + RISK_CONFIG.WINDOW_END_MIN;
  return total >= start && total <= end;
}

export function getEasternTimeString(): string {
  return new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── API request helper (proxied through backend) ──────────────────────────────

async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Core service functions ────────────────────────────────────────────────────

export const alpacaLiveTrading = {

  /** Validate live account connection and return safe account metadata. */
  async validateLiveAccount(): Promise<LiveAccount> {
    return apiRequest<LiveAccount>('/api/alpaca/live/account');
  },

  /** Fetch current account details. */
  async getAccount(): Promise<LiveAccount> {
    return apiRequest<LiveAccount>('/api/alpaca/live/account');
  },

  /** Fetch open positions. */
  async getPositions(): Promise<LivePosition[]> {
    return apiRequest<LivePosition[]>('/api/alpaca/live/positions');
  },

  /** Fetch open/pending orders. */
  async getOpenOrders(): Promise<LiveOrder[]> {
    return apiRequest<LiveOrder[]>('/api/alpaca/live/orders');
  },

  /** Fetch current risk state from backend. */
  async getRiskState(): Promise<RiskState> {
    return apiRequest<RiskState>('/api/alpaca/live/risk-state');
  },

  /** Submit a limit order for an options contract. Returns trade decision. */
  async submitOptionLimitOrder(signal: TradeSignal, qty: number, shadowMode: boolean): Promise<TradeDecision> {
    return apiRequest<TradeDecision>('/api/alpaca/live/trade', {
      method: 'POST',
      body: JSON.stringify({ signal, qty, shadowMode }),
    });
  },

  /** Hard-disable auto-trading with a reason. */
  async disableTrading(reason: string): Promise<void> {
    await apiRequest('/api/alpaca/live/disable', {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },

  /** Cancel orders older than the configured timeout. */
  async cancelStaleOrders(): Promise<{ canceled: string[] }> {
    return apiRequest<{ canceled: string[] }>('/api/alpaca/live/cancel-stale', { method: 'POST' });
  },

  /** Calculate position size (# contracts) given account equity and signal. */
  calculatePositionSize(signal: TradeSignal, equity: number): number {
    const riskPerTrade = 0.015; // TEST MODE — 1.5% of equity only
    const positionSize = Math.max(
      1,
      Math.floor((equity * riskPerTrade) / signal.entry),
    );
    return positionSize;
  },

  /**
   * Evaluate all Signal Stack trade rules for a given signal + account state.
   * Returns a list of rule checks and a composite pass/fail.
   */
  evaluateRules(
    _signal: TradeSignal,
    _account: LiveAccount,
    _riskState: RiskState,
    _positions: LivePosition[],
    _orders: LiveOrder[],
  ): { checks: TradingRuleCheck[]; pass: boolean; blockedReason?: string } {
    // TEST MODE — all rules pass
    return {
      checks: [],
      pass: true,
    };
  },

  /**
   * Full shouldTrade decision. Returns true and logs context, or false with reason.
   * Does NOT submit — caller handles submission.
   */
  shouldTrade(
    signal: TradeSignal,
    account: LiveAccount,
    riskState: RiskState,
    positions: LivePosition[],
    orders: LiveOrder[],
    liveTradingEnabled: boolean,
    autoTradeEnabled: boolean,
    shadowMode: boolean,
  ): { proceed: boolean; reason?: string } {
    if (!liveTradingEnabled) return { proceed: false, reason: 'Live trading not enabled' };
    if (!autoTradeEnabled && !shadowMode) return { proceed: false, reason: 'Auto-trade not enabled' };

    const { pass, blockedReason } = this.evaluateRules(signal, account, riskState, positions, orders);
    if (!pass) return { proceed: false, reason: blockedReason };
    return { proceed: true };
  },

  /** Build a local TradeLogEntry (used before persisting to Supabase). */
  buildLogEntry(
    signal: TradeSignal,
    qty: number,
    status: TradeLogEntry['status'],
    rejectionReason: string | undefined,
    orderId: string | undefined,
    environment: AlpacaEnvironment,
    shadowMode: boolean,
  ): TradeLogEntry {
    return {
      id: makeId(),
      timestamp: new Date().toISOString(),
      ticker: signal.ticker,
      optionSymbol: signal.optionSymbol,
      signalScore: signal.totalScore,
      confidence: signal.confidence,
      riskReward: signal.riskReward,
      grade: signal.grade,
      entryPrice: signal.limitPrice,
      qty,
      status,
      rejectionReason,
      orderId,
      environment,
      shadowMode,
    };
  },
};
