// ── Account State Service ─────────────────────────────────────────────────────
// Maintains real-time awareness of account buying power, equity, and cash.
// All calls are proxied through the Supabase Edge Function — no credentials in the browser.
//
// BUYING POWER RULES:
//   - Pre-trade check: estimatedCost must be < buyingPower
//   - Minimum reserve: at least MIN_BUYING_POWER_RESERVE must remain after trade
//   - Post-trade: re-fetch and update state after every fill

import { ALPACA_API_BASE as API_BASE_URL } from '../lib/apiBase';

// Options contracts have a 100-share multiplier
export const OPTIONS_CONTRACT_MULTIPLIER = 100;

// Minimum buying power that must remain after any trade (circuit breaker)
export const MIN_BUYING_POWER_RESERVE = 5;

// ── Types ─────────────────────────────────────────────────────────────────────

export type AccountState = {
  equity:               number;
  buyingPower:          number;
  cash:                 number;
  dayTradingBuyingPower: number;
  portfolioValue:       number;
  openPositionsCount:   number;
  lastFetched:          string;   // ISO timestamp
  fetchError:           string | null;
};

export type BuyingPowerCheck = {
  sufficient:            boolean;
  estimatedCost:         number;
  availableBuyingPower:  number;
  remainingAfterTrade:   number;
  blockedReason:         string | null;
};

export type AccountSnapshot = {
  type:          'pre_trade' | 'post_trade' | 'periodic';
  equity:        number;
  buyingPower:   number;
  cash:          number;
  portfolioValue: number;
  openPositions: number;
  recordedAt:    string;
};

// ── Internal state (singleton cache) ─────────────────────────────────────────

let _cached: AccountState | null = null;
let _lastFetchMs = 0;
const CACHE_TTL_MS = 15_000; // 15 seconds

// ── API helper ────────────────────────────────────────────────────────────────

async function fetchFromServer<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Public API ────────────────────────────────────────────────────────────────

export const accountState = {

  /**
   * Fetch account state from backend.
   * Uses a 15-second cache unless force=true is passed.
   */
  async getAccountState(env = 'live', force = false): Promise<AccountState> {
    const now = Date.now();
    if (!force && _cached && now - _lastFetchMs < CACHE_TTL_MS) {
      return _cached;
    }

    try {
      type AccountPayload = {
        equity: number; buyingPower: number; cash: number;
        dayTradingBuyingPower?: number; portfolioValue: number;
      };
      type PositionsPayload = Array<unknown>;

      // /account-state returns dayTradingBuyingPower + openPositionsCount in one call
      const [acct, positions] = await Promise.all([
        fetchFromServer<AccountPayload>(`/api/alpaca/live/account-state?env=${env}`),
        fetchFromServer<PositionsPayload>(`/api/alpaca/live/positions?env=${env}`),
      ]);

      _cached = {
        equity:               acct.equity               ?? 0,
        buyingPower:          acct.buyingPower           ?? 0,
        cash:                 acct.cash                  ?? 0,
        dayTradingBuyingPower: acct.dayTradingBuyingPower ?? acct.buyingPower ?? 0,
        portfolioValue:       acct.portfolioValue        ?? 0,
        openPositionsCount:   positions.length,
        lastFetched:          new Date().toISOString(),
        fetchError:           null,
      };
      _lastFetchMs = now;
      return _cached;

    } catch (err) {
      const fetchError = err instanceof Error ? err.message : 'Failed to fetch account';
      const stale: AccountState = _cached
        ? { ..._cached, fetchError, lastFetched: new Date().toISOString() }
        : { equity: 0, buyingPower: 0, cash: 0, dayTradingBuyingPower: 0, portfolioValue: 0, openPositionsCount: 0, lastFetched: new Date().toISOString(), fetchError };
      _cached = stale;
      throw new Error(fetchError);
    }
  },

  /** Force-refresh buying power (bypasses cache). */
  async getBuyingPower(env = 'live'): Promise<number> {
    const state = await this.getAccountState(env, true);
    return state.buyingPower;
  },

  /** Force-refresh equity (bypasses cache). */
  async getEquity(env = 'live'): Promise<number> {
    const state = await this.getAccountState(env, true);
    return state.equity;
  },

  /** Return cached state without network call. Returns null if never fetched. */
  getCached(): AccountState | null {
    return _cached;
  },

  /** Invalidate cache — forces next call to re-fetch from server. */
  invalidate(): void {
    _lastFetchMs = 0;
  },

  /**
   * Pre-trade buying power check.
   * Returns BuyingPowerCheck with sufficient=false and blockedReason if the
   * trade would exceed available funds or leave too little reserve.
   */
  checkBuyingPower(
    limitPrice: number,
    quantity: number,
    currentBuyingPower: number,
  ): BuyingPowerCheck {
    // Options: 1 contract = 100 shares * limitPrice (quoted per share)
    const estimatedCost = limitPrice * OPTIONS_CONTRACT_MULTIPLIER * quantity;
    const remainingAfterTrade = currentBuyingPower - estimatedCost;

    if (currentBuyingPower <= 0) {
      return {
        sufficient: false,
        estimatedCost,
        availableBuyingPower: currentBuyingPower,
        remainingAfterTrade,
        blockedReason: 'INSUFFICIENT BUYING POWER — buying power is zero or negative',
      };
    }

    if (estimatedCost > currentBuyingPower) {
      return {
        sufficient: false,
        estimatedCost,
        availableBuyingPower: currentBuyingPower,
        remainingAfterTrade,
        blockedReason: `INSUFFICIENT BUYING POWER — cost $${estimatedCost.toFixed(2)} exceeds available $${currentBuyingPower.toFixed(2)}`,
      };
    }

    if (remainingAfterTrade < MIN_BUYING_POWER_RESERVE) {
      return {
        sufficient: false,
        estimatedCost,
        availableBuyingPower: currentBuyingPower,
        remainingAfterTrade,
        blockedReason: `INSUFFICIENT BUYING POWER — remaining $${remainingAfterTrade.toFixed(2)} would fall below reserve $${MIN_BUYING_POWER_RESERVE}`,
      };
    }

    return {
      sufficient: true,
      estimatedCost,
      availableBuyingPower: currentBuyingPower,
      remainingAfterTrade,
      blockedReason: null,
    };
  },

  /** Build a snapshot object for persistence. */
  buildSnapshot(
    state: AccountState,
    type: AccountSnapshot['type'],
  ): AccountSnapshot {
    return {
      type,
      equity:        state.equity,
      buyingPower:   state.buyingPower,
      cash:          state.cash,
      portfolioValue: state.portfolioValue,
      openPositions: state.openPositionsCount,
      recordedAt:    new Date().toISOString(),
    };
  },
};
