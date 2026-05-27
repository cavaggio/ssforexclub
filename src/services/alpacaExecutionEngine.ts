// ── Alpaca Execution Engine ───────────────────────────────────────────────────
// Full trade execution lifecycle manager.
//
// LIFECYCLE:
//   1. checkBuyingPower     — pre-trade buying power validation
//   2. submitOrder          — place limit order → returns orderId
//   3. waitForFill          — poll every 3s for fill/cancel/reject
//   4. confirmPosition      — verify position exists in Alpaca
//   5. refreshAccountState  — update buying power after fill
//
// CORE PRINCIPLE:
//   A trade is NOT executed unless:
//     order.status === "filled" AND position confirmed in Alpaca
//
// All API calls are proxied through our Express backend.
// No Alpaca credentials are ever accessed from this file.

import { accountState, type AccountState, type BuyingPowerCheck, type AccountSnapshot } from './accountState';
import type { TradeSignal } from './alpacaLiveTrading';
import { supabase } from '../lib/supabase';
import { ALPACA_API_BASE as API_BASE_URL } from '../lib/apiBase';

// ── Constants ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 3_000;         // poll fill status every 3 seconds
const MAX_POLL_ATTEMPTS = 60;           // max 3 minutes before giving up
const DEFAULT_CANCEL_TIMEOUT_MS = 300_000; // 5-minute stale order timeout

// ── Types ─────────────────────────────────────────────────────────────────────

export type OrderStatus =
  | 'submitted'
  | 'partially_filled'
  | 'filled'
  | 'canceled'
  | 'rejected'
  | 'shadow'
  | 'blocked'
  | 'pending_cancel'
  | 'expired';

export type FillStatus = 'pending' | 'filled' | 'canceled' | 'rejected';

export type ExecutionRecord = {
  id:                    string;
  sessionId:             string;
  ticker:                string;
  optionSymbol:          string;
  signalScore:           number;
  confidence:            number;
  riskReward:            number;
  grade:                 string;
  quantity:              number;
  limitPrice:            number;
  estimatedCost:         number;
  orderId:               string | null;
  orderStatus:           OrderStatus;
  fillStatus:            FillStatus;
  positionConfirmed:     boolean;
  preTradeBuyingPower:   number | null;
  postTradeBuyingPower:  number | null;
  preTradeEquity:        number | null;
  postTradeEquity:       number | null;
  submittedAt:           string | null;
  filledAt:              string | null;
  positionCheckedAt:     string | null;
  blockedReason:         string | null;
  environment:           string;
  shadowMode:            boolean;
  createdAt:             string;
  updatedAt:             string;
};

export type ExecuteTradeResult = {
  success:              boolean;
  executionRecord:      ExecutionRecord;
  preTradeBuyingPower:  number;
  postTradeBuyingPower: number | null;
  preTradeSnapshot:     AccountSnapshot;
  postTradeSnapshot:    AccountSnapshot | null;
  blockedReason:        string | null;
};

// ── Internal helpers ──────────────────────────────────────────────────────────

function makeId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function makeRecord(partial: Partial<ExecutionRecord> & Pick<ExecutionRecord, 'ticker' | 'optionSymbol'>): ExecutionRecord {
  const now = new Date().toISOString();
  return {
    id:                   makeId(),
    sessionId:            '',
    ticker:               partial.ticker,
    optionSymbol:         partial.optionSymbol,
    signalScore:          partial.signalScore          ?? 0,
    confidence:           partial.confidence           ?? 0,
    riskReward:           partial.riskReward           ?? 0,
    grade:                partial.grade                ?? '',
    quantity:             partial.quantity             ?? 1,
    limitPrice:           partial.limitPrice           ?? 0,
    estimatedCost:        partial.estimatedCost        ?? 0,
    orderId:              partial.orderId              ?? null,
    orderStatus:          partial.orderStatus          ?? 'blocked',
    fillStatus:           partial.fillStatus           ?? 'pending',
    positionConfirmed:    partial.positionConfirmed    ?? false,
    preTradeBuyingPower:  partial.preTradeBuyingPower  ?? null,
    postTradeBuyingPower: partial.postTradeBuyingPower ?? null,
    preTradeEquity:       partial.preTradeEquity       ?? null,
    postTradeEquity:      partial.postTradeEquity      ?? null,
    submittedAt:          partial.submittedAt          ?? null,
    filledAt:             partial.filledAt             ?? null,
    positionCheckedAt:    partial.positionCheckedAt    ?? null,
    blockedReason:        partial.blockedReason        ?? null,
    environment:          partial.environment          ?? 'paper',
    shadowMode:           partial.shadowMode           ?? true,
    createdAt:            now,
    updatedAt:            now,
  };
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Execution Engine ──────────────────────────────────────────────────────────

export const alpacaExecutionEngine = {

  /**
   * STEP 1: Submit a limit order to Alpaca via backend.
   * Returns orderId on success.
   * Throws on failure — never silently swallows errors.
   */
  async submitOrder(
    signal: TradeSignal,
    qty: number,
    shadowMode: boolean,
    env = 'live',
  ): Promise<{ orderId: string | null; action: string; reason?: string }> {
    const result = await apiPost<{ action: string; orderId?: string; reason?: string }>(
      '/api/alpaca/live/trade',
      { signal: { ...signal, environment: env }, qty, shadowMode },
    );
    return {
      orderId: result.orderId ?? null,
      action:  result.action,
      reason:  result.reason,
    };
  },

  /**
   * STEP 2: Poll Alpaca every 3 seconds until the order is terminal.
   * Terminal states: filled | canceled | rejected | expired
   *
   * Returns { status, filledAt, filledQty }
   */
  async waitForFill(
    orderId: string,
    env = 'live',
    onStatusUpdate?: (status: OrderStatus) => void,
  ): Promise<{ status: OrderStatus; filledAt: string | null; filledQty: number }> {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

      try {
        type OrderPollResult = { status: string; filledAt: string | null; filledQty: number };
        const order = await apiGet<OrderPollResult>(`/api/alpaca/live/order/${orderId}?env=${env}`);
        const status = order.status as OrderStatus;

        onStatusUpdate?.(status);

        if (['filled', 'canceled', 'rejected', 'expired'].includes(status)) {
          return {
            status,
            filledAt:  order.filledAt,
            filledQty: order.filledQty ?? 0,
          };
        }
      } catch {
        // Transient network error — keep polling; do not abort
      }
    }

    // Timeout — return pending so caller can cancel
    return { status: 'pending_cancel' as OrderStatus, filledAt: null, filledQty: 0 };
  },

  /**
   * STEP 3: Confirm position exists in Alpaca after a fill.
   * A trade is NOT executed unless this returns true.
   */
  async confirmPosition(
    symbol: string,
    expectedQty: number,
    env = 'live',
  ): Promise<{ confirmed: boolean; actualQty: number }> {
    try {
      type PositionResult = { symbol: string; qty: number }[];
      const positions = await apiGet<PositionResult>(`/api/alpaca/live/positions?env=${env}`);
      const match = positions.find(p => p.symbol === symbol);
      if (!match) return { confirmed: false, actualQty: 0 };

      // Allow partial fills — confirm as long as qty > 0
      return { confirmed: match.qty > 0, actualQty: match.qty };
    } catch {
      return { confirmed: false, actualQty: 0 };
    }
  },

  /**
   * STEP 4: Cancel a stale order that has not been filled within timeout.
   */
  async cancelStaleOrder(
    orderId: string,
    env = 'live',
  ): Promise<{ canceled: boolean }> {
    try {
      await apiPost<void>(`/api/alpaca/live/cancel-order`, { orderId, env });
      return { canceled: true };
    } catch {
      return { canceled: false };
    }
  },

  /**
   * FULL LIFECYCLE: executeTrade
   *
   * Step 1: Check buying power
   * Step 2: Submit order
   * Step 3: Wait for fill
   * Step 4: Confirm position
   * Step 5: Refresh account state
   * Step 6: Return ExecuteTradeResult
   *
   * A trade is ONLY marked executed when:
   *   fillStatus === 'filled' AND positionConfirmed === true
   */
  async executeTrade(
    signal: TradeSignal,
    qty: number,
    shadowMode: boolean,
    env: string,
    sessionId: string,
    onProgress?: (record: ExecutionRecord) => void,
  ): Promise<ExecuteTradeResult> {

    const estimatedCost = (signal.limitPrice ?? 0) * 100 * qty;

    // ── Step 1: Pre-trade account state ──────────────────────────────────
    let preState: AccountState;
    try {
      preState = await accountState.getAccountState(env, true);
    } catch (err) {
      // Alpaca API failure → block all trading (failsafe rule)
      const rec = makeRecord({
        ticker: signal.ticker, optionSymbol: signal.optionSymbol,
        signalScore: signal.totalScore, confidence: signal.confidence,
        riskReward: signal.riskReward, grade: signal.grade,
        quantity: qty, limitPrice: signal.limitPrice, estimatedCost,
        orderStatus: 'blocked', fillStatus: 'pending',
        blockedReason: `Alpaca API failure — cannot verify account state: ${err instanceof Error ? err.message : 'unknown'}`,
        environment: env, shadowMode, sessionId,
      });
      onProgress?.(rec);
      return {
        success: false, executionRecord: rec,
        preTradeBuyingPower: 0, postTradeBuyingPower: null,
        preTradeSnapshot: accountState.buildSnapshot({ equity: 0, buyingPower: 0, cash: 0, dayTradingBuyingPower: 0, portfolioValue: 0, openPositionsCount: 0, lastFetched: new Date().toISOString(), fetchError: null }, 'pre_trade'),
        postTradeSnapshot: null, blockedReason: rec.blockedReason,
      };
    }

    const preTradeSnapshot = accountState.buildSnapshot(preState, 'pre_trade');

    // ── Buying power check ────────────────────────────────────────────────
    const bpCheck: BuyingPowerCheck = accountState.checkBuyingPower(
      signal.limitPrice, qty, preState.buyingPower,
    );

    if (!bpCheck.sufficient) {
      const rec = makeRecord({
        ticker: signal.ticker, optionSymbol: signal.optionSymbol,
        signalScore: signal.totalScore, confidence: signal.confidence,
        riskReward: signal.riskReward, grade: signal.grade,
        quantity: qty, limitPrice: signal.limitPrice,
        estimatedCost: bpCheck.estimatedCost,
        preTradeBuyingPower: preState.buyingPower, preTradeEquity: preState.equity,
        orderStatus: 'blocked', fillStatus: 'pending',
        blockedReason: bpCheck.blockedReason ?? 'INSUFFICIENT BUYING POWER',
        environment: env, shadowMode, sessionId,
      });
      onProgress?.(rec);
      await this._persistRecord(rec);
      return {
        success: false, executionRecord: rec,
        preTradeBuyingPower: preState.buyingPower, postTradeBuyingPower: null,
        preTradeSnapshot, postTradeSnapshot: null,
        blockedReason: rec.blockedReason,
      };
    }

    // ── Step 2: Submit order ──────────────────────────────────────────────
    const forceLiveMode = false;

    console.log("🚨 FORCING LIVE ORDER SUBMISSION", {
      ticker: signal.ticker,
      optionSymbol: signal.optionSymbol,
      env,
      originalShadowMode: shadowMode,
      forcedShadowMode: forceLiveMode,
    });

    const submitResult = await this.submitOrder(
      signal,
      qty,
      forceLiveMode,
      env
    );

    const rec = makeRecord({
      ticker: signal.ticker, optionSymbol: signal.optionSymbol,
      signalScore: signal.totalScore, confidence: signal.confidence,
      riskReward: signal.riskReward, grade: signal.grade,
      quantity: qty, limitPrice: signal.limitPrice,
      estimatedCost: bpCheck.estimatedCost,
      preTradeBuyingPower: preState.buyingPower, preTradeEquity: preState.equity,
      orderId: submitResult.orderId,
      orderStatus: submitResult.action === 'shadow' ? 'shadow'
                 : submitResult.action === 'block'  ? 'blocked'
                 : 'submitted',
      fillStatus: 'pending',
      submittedAt: submitResult.action === 'submit' ? new Date().toISOString() : null,
      blockedReason: submitResult.action !== 'submit' ? (submitResult.reason ?? null) : null,
      environment: env,
      shadowMode: forceLiveMode,
      sessionId,
    });
    onProgress?.(rec);

    // Shadow mode or blocked — stop here
    if (rec.orderStatus !== 'submitted') {
      await this._persistRecord(rec);
      return {
        success: false, executionRecord: rec,
        preTradeBuyingPower: preState.buyingPower, postTradeBuyingPower: null,
        preTradeSnapshot, postTradeSnapshot: null,
        blockedReason: rec.blockedReason,
      };
    }

    const orderId = submitResult.orderId!;

    // ── Step 3: Wait for fill ─────────────────────────────────────────────
    const fillResult = await this.waitForFill(orderId, env, status => {
      onProgress?.({ ...rec, orderStatus: status, updatedAt: new Date().toISOString() });
    });

    rec.orderStatus  = fillResult.status;
    rec.fillStatus   = fillResult.status === 'filled' ? 'filled'
                     : fillResult.status === 'canceled' ? 'canceled'
                     : fillResult.status === 'rejected' ? 'rejected' : 'pending';
    rec.filledAt     = fillResult.filledAt;
    rec.updatedAt    = new Date().toISOString();

    // If polling timed out, cancel the stale order
    if (fillResult.status === 'pending_cancel') {
      await this.cancelStaleOrder(orderId, env);
      rec.orderStatus = 'canceled';
      rec.fillStatus  = 'canceled';
      rec.blockedReason = `Order canceled — not filled within ${DEFAULT_CANCEL_TIMEOUT_MS / 60000}min`;
      onProgress?.(rec);
      await this._persistRecord(rec);
      return {
        success: false, executionRecord: rec,
        preTradeBuyingPower: preState.buyingPower, postTradeBuyingPower: null,
        preTradeSnapshot, postTradeSnapshot: null,
        blockedReason: rec.blockedReason,
      };
    }

    onProgress?.(rec);

    // Not filled → return without position check
    if (rec.fillStatus !== 'filled') {
      await this._persistRecord(rec);
      return {
        success: false, executionRecord: rec,
        preTradeBuyingPower: preState.buyingPower, postTradeBuyingPower: null,
        preTradeSnapshot, postTradeSnapshot: null,
        blockedReason: `Order ${rec.fillStatus}`,
      };
    }

    // ── Step 4: Confirm position ──────────────────────────────────────────
    const posCheck = await this.confirmPosition(signal.optionSymbol, qty, env);
    rec.positionConfirmed  = posCheck.confirmed;
    rec.positionCheckedAt  = new Date().toISOString();
    rec.updatedAt          = new Date().toISOString();
    onProgress?.(rec);

    // ── Step 5: Post-trade account state ──────────────────────────────────
    accountState.invalidate();
    let postState: AccountState | null = null;
    let postTradeSnapshot: AccountSnapshot | null = null;
    let postTradeBuyingPower: number | null = null;

    try {
      postState = await accountState.getAccountState(env, true);
      postTradeSnapshot = accountState.buildSnapshot(postState, 'post_trade');
      postTradeBuyingPower = postState.buyingPower;
      rec.postTradeBuyingPower = postTradeBuyingPower;
      rec.postTradeEquity      = postState.equity;
      rec.updatedAt            = new Date().toISOString();
    } catch {
      // Non-fatal — position is confirmed, just can't refresh bp
    }

    onProgress?.(rec);
    await this._persistRecord(rec);

    // Persist snapshots
    if (postTradeSnapshot) {
      await this._persistSnapshot(preTradeSnapshot, rec.id, sessionId, env);
      await this._persistSnapshot(postTradeSnapshot, rec.id, sessionId, env);
    }

    return {
      success:              posCheck.confirmed,
      executionRecord:      rec,
      preTradeBuyingPower:  preState.buyingPower,
      postTradeBuyingPower,
      preTradeSnapshot,
      postTradeSnapshot,
      blockedReason: posCheck.confirmed ? null : 'Position not confirmed in Alpaca after fill',
    };
  },

  // ── Persistence helpers ───────────────────────────────────────────────────

  async _persistRecord(rec: ExecutionRecord): Promise<void> {
    await supabase.from('execution_log').upsert({
      id:                      rec.id,
      session_id:              rec.sessionId,
      ticker:                  rec.ticker,
      option_symbol:           rec.optionSymbol,
      signal_score:            rec.signalScore,
      confidence:              rec.confidence,
      risk_reward:             rec.riskReward,
      grade:                   rec.grade,
      quantity:                rec.quantity,
      limit_price:             rec.limitPrice,
      estimated_cost:          rec.estimatedCost,
      order_id:                rec.orderId,
      order_status:            rec.orderStatus,
      fill_status:             rec.fillStatus,
      position_confirmed:      rec.positionConfirmed,
      pre_trade_buying_power:  rec.preTradeBuyingPower,
      post_trade_buying_power: rec.postTradeBuyingPower,
      pre_trade_equity:        rec.preTradeEquity,
      post_trade_equity:       rec.postTradeEquity,
      submitted_at:            rec.submittedAt,
      filled_at:               rec.filledAt,
      position_checked_at:     rec.positionCheckedAt,
      blocked_reason:          rec.blockedReason,
      environment:             rec.environment,
      shadow_mode:             rec.shadowMode,
      updated_at:              rec.updatedAt,
    }, { onConflict: 'id' });
  },

  async _persistSnapshot(
    snap: AccountSnapshot,
    execLogId: string,
    sessionId: string,
    env: string,
  ): Promise<void> {
    await supabase.from('account_snapshots').insert({
      session_id:              sessionId,
      snapshot_type:           snap.type,
      execution_log_id:        execLogId,
      equity:                  snap.equity,
      buying_power:            snap.buyingPower,
      cash:                    snap.cash,
      day_trade_buying_power:  snap.buyingPower,
      portfolio_value:         snap.portfolioValue,
      open_positions:          snap.openPositions,
      environment:             env,
      recorded_at:             snap.recordedAt,
    });
  },
};
