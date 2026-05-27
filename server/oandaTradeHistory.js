/**
 * server/oandaTradeHistory.js
 * Persists trade history to forex_trade_history.json.
 * Tracks pair, session, score, result, PnL, duration.
 * Calculates rolling win rate and expectancy per pair+session combination.
 * Used to penalise historically poor combinations and boost strong ones.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const HISTORY_FILE = join(process.cwd(), 'forex_trade_history.json');
const MAX_HISTORY = 1000;

function loadHistory() {
  if (!existsSync(HISTORY_FILE)) return [];
  try {
    const raw = readFileSync(HISTORY_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    console.warn('[TRADE_HISTORY] Failed to parse history file — starting fresh.');
    return [];
  }
}

function saveHistory(history) {
  const trimmed = history.slice(-MAX_HISTORY);
  writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2), 'utf-8');
}

/**
 * Record a new trade (result is 'pending' until the position closes).
 */
export function recordTrade(trade) {
  const history = loadHistory();
  const entry = {
    id: `${Date.now()}_${trade.pair}`,
    timestamp: new Date().toISOString(),
    pair: trade.pair,
    direction: trade.direction,
    session: trade.session || 'Unknown',
    timeframe: trade.timeframe || 'M15',
    score: trade.score,
    confidence: trade.confidence,
    scoreBreakdown: trade.scoreBreakdown || {},
    entry: trade.entry,
    stopLoss: trade.stopLoss,
    takeProfit: trade.takeProfit,
    riskReward: trade.riskReward,
    atrPips: trade.atrPips || null,
    trend: trade.trend || null,
    mtfAlignment: trade.mtfAlignment || null,
    marketStructure: trade.marketStructure || null,
    units: trade.units,
    riskAmount: trade.riskAmount,
    result: 'pending',
    pnl: null,
    durationMinutes: null,
    oandaOrderId: trade.oandaOrderId || null,
  };
  history.push(entry);
  saveHistory(history);
  console.log(`[TRADE_HISTORY] Recorded trade: ${entry.id}`);
  return entry.id;
}

/**
 * Update a pending trade with its final result and PnL.
 */
export function resolveTradeResult(tradeId, result, pnl, durationMinutes) {
  const history = loadHistory();
  const trade = history.find((t) => t.id === tradeId);
  if (trade) {
    trade.result = result;
    trade.pnl = pnl;
    trade.durationMinutes = durationMinutes;
    saveHistory(history);
    console.log(`[TRADE_HISTORY] Resolved trade ${tradeId}: ${result}, PnL: ${pnl}`);
  }
}

/**
 * Retrieve trade history (most recent first).
 */
export function getTradeHistory(limit = 100) {
  const history = loadHistory();
  return history.slice(-limit).reverse();
}

/**
 * Calculate rolling performance stats per pair+session.
 */
export function getPerformanceStats() {
  const history = loadHistory().filter((t) => t.result !== 'pending');

  const buckets = {};
  for (const trade of history) {
    const key = `${trade.pair}::${trade.session}`;
    if (!buckets[key]) {
      buckets[key] = {
        pair: trade.pair,
        session: trade.session,
        wins: 0,
        losses: 0,
        totalPnl: 0,
        trades: 0,
        avgScore: 0,
        totalScore: 0,
      };
    }
    const b = buckets[key];
    b.trades++;
    b.totalScore += trade.score || 0;
    b.avgScore = +(b.totalScore / b.trades).toFixed(1);
    if (trade.result === 'win') { b.wins++; b.totalPnl += (trade.pnl || 0); }
    if (trade.result === 'loss') { b.losses++; b.totalPnl += (trade.pnl || 0); }
  }

  return Object.values(buckets).map((b) => ({
    ...b,
    winRate: b.trades > 0 ? +(b.wins / b.trades * 100).toFixed(1) : null,
    expectancy: b.trades > 0 ? +(b.totalPnl / b.trades).toFixed(2) : null,
    totalPnl: +b.totalPnl.toFixed(2),
  }));
}

/**
 * Score penalty multiplier for a pair+session based on historical win rate.
 * Returns 1.0 (no penalty) down to 0.5 (heavy penalty).
 * Requires at least 5 closed trades to apply a penalty.
 */
export function getPairSessionPenalty(pair, session) {
  const history = loadHistory().filter(
    (t) => t.pair === pair && t.session === session && t.result !== 'pending'
  );
  if (history.length < 5) return 1.0;

  const wins = history.filter((t) => t.result === 'win').length;
  const winRate = wins / history.length;

  if (winRate < 0.25) return 0.5;
  if (winRate < 0.35) return 0.65;
  if (winRate < 0.45) return 0.80;
  return 1.0;
}

/**
 * Historical win rate for a specific pair+session (0-1, or null if insufficient data).
 */
export function getWinRate(pair, session) {
  const history = loadHistory().filter(
    (t) => t.pair === pair && t.session === session && t.result !== 'pending'
  );
  if (history.length < 3) return null;
  const wins = history.filter((t) => t.result === 'win').length;
  return +(wins / history.length).toFixed(3);
}
