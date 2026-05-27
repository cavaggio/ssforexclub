/**
 * src/hooks/useForexTrades.ts
 * React hook for trade submission, position closing, and trade history.
 * Keeps trade state in sync with the backend on every action.
 */

import { useState, useEffect, useCallback } from 'react';
import type { ForexSignal, ForexTradeResult, ForexTradeState } from '../types/forex.ts';
import type { TradeHistoryEntry, PerformanceStat } from '../types/forex.ts';

const API = '/api/oanda';

export interface UseForexTradesReturn {
  tradeResults: Record<string, ForexTradeResult>;
  tradeState: ForexTradeState | null;
  tradeHistory: TradeHistoryEntry[];
  performanceStats: PerformanceStat[];
  isSubmitting: Record<string, boolean>;
  submitTrade: (signal: ForexSignal) => Promise<void>;
  closePosition: (instrument: string) => Promise<{ success: boolean; reason?: string }>;
  refreshTradeState: () => Promise<void>;
}

export function useForexTrades(): UseForexTradesReturn {
  const [tradeResults, setTradeResults] = useState<Record<string, ForexTradeResult>>({});
  const [tradeState, setTradeState] = useState<ForexTradeState | null>(null);
  const [tradeHistory, setTradeHistory] = useState<TradeHistoryEntry[]>([]);
  const [performanceStats, setPerformanceStats] = useState<PerformanceStat[]>([]);
  const [isSubmitting, setIsSubmitting] = useState<Record<string, boolean>>({});

  const refreshTradeState = useCallback(async () => {
    try {
      const [stateRes, historyRes, perfRes] = await Promise.all([
        fetch(`${API}/trade-state`),
        fetch(`${API}/trade-history`),
        fetch(`${API}/performance`),
      ]);
      if (stateRes.ok) setTradeState(await stateRes.json());
      if (historyRes.ok) {
        const h = await historyRes.json();
        setTradeHistory(h.history || []);
      }
      if (perfRes.ok) {
        const p = await perfRes.json();
        setPerformanceStats(p.stats || []);
      }
    } catch {
      // Non-fatal — trade state will update on next action
    }
  }, []);

  const submitTrade = useCallback(async (signal: ForexSignal) => {
    const key = `${signal.pair}_${signal.direction}`;
    setIsSubmitting((prev) => ({ ...prev, [key]: true }));
    try {
      const res = await fetch(`${API}/trade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signal }),
      });
      const result: ForexTradeResult = await res.json();
      setTradeResults((prev) => ({ ...prev, [key]: result }));
      await refreshTradeState();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Trade failed';
      setTradeResults((prev) => ({
        ...prev,
        [key]: { success: false, blocked: false, reason: msg },
      }));
    } finally {
      setIsSubmitting((prev) => ({ ...prev, [key]: false }));
    }
  }, [refreshTradeState]);

  const closePosition = useCallback(async (instrument: string) => {
    try {
      const res = await fetch(`${API}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instrument }),
      });
      const result = await res.json();
      await refreshTradeState();
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Close failed';
      return { success: false, reason: msg };
    }
  }, [refreshTradeState]);

  useEffect(() => {
    refreshTradeState();
  }, [refreshTradeState]);

  return {
    tradeResults,
    tradeState,
    tradeHistory,
    performanceStats,
    isSubmitting,
    submitTrade,
    closePosition,
    refreshTradeState,
  };
}
