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
 *
 * Entry-context fields (2026-05-27 active-trade-mgmt upgrade) — Part 9 of the
 * spec. Stored at entry so subsequent reassessments can compare current
 * market conditions against the state when the trade was opened.
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
    entryQualityConfidence: trade.entryQualityConfidence ?? null,
    entryTpHitConfidence: trade.entryTpHitConfidence ?? trade.tpHitConfidence ?? null,
    entryStrategy: trade.entryStrategy ?? trade.strategy ?? null,
    actualFillRR: trade.actualFillRR ?? trade.riskReward ?? null,
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
    // ── Entry context (NEW) ────────────────────────────────────────────────
    entryMarketState:            trade.entryMarketState            ?? null,
    entryMarketStateScore:       trade.entryMarketStateScore       ?? null,
    entryCandleStrengthScore:    trade.entryCandleStrengthScore    ?? null,
    entryMtfAlignmentScore:      trade.entryMtfAlignmentScore      ?? null,
    entryATR:                    trade.entryATR                    ?? null,
    entryExpectedHoldTimeMinutes:trade.entryExpectedHoldTimeMinutes?? null,
    entrySelectedLogicType:      trade.entrySelectedLogicType      ?? null,
    entryAssetClass:             trade.entryAssetClass             ?? null,
    entryRiskRewardRatio:        trade.entryRiskRewardRatio        ?? trade.riskReward ?? null,
    entrySession:                trade.entrySession                ?? trade.session ?? null,
    entrySpreadPips:             trade.entrySpreadPips             ?? null,
    originalRecommendedTP:       trade.originalRecommendedTP       ?? trade.takeProfit ?? null,
    originalRecommendedSL:       trade.originalRecommendedSL       ?? trade.stopLoss ?? null,
    entryRejectionWarnings:      trade.entryRejectionWarnings      ?? [],
    // ── Active-management tracking (NEW) ───────────────────────────────────
    maxFavorableExcursionPips:   0,   // updated by reassessor
    lastReassessedAt:            null,
    // ── Signal Stack V3 — expected vs realised feedback (2026-05-30) ───────
    // Calibrated expected RR (not geometric) — drives the calibration engine
    // that auto-adjusts the rejection threshold based on capture ratio.
    expectedRR:              trade.expectedRR              ?? null,
    expectedRiskPips:        trade.expectedRiskPips        ?? null,
    expectedRewardPips:      trade.expectedRewardPips      ?? null,
    rrTier:                  trade.rrTier                  ?? null,
    rrQualityFactor:         trade.rrQualityFactor         ?? null,
    realizedR:               null,    // populated by resolveTradeResult
    resolvedAt:              null,
  };
  history.push(entry);
  saveHistory(history);
  console.log(`[TRADE_HISTORY] Recorded trade: ${entry.id}`);
  return entry.id;
}

/**
 * Update a pending trade's max-favorable-excursion (MFE) in pips.
 * Called by the reassessor on every reassessment cycle.
 *
 * Match priority: id (preferred), then oandaOrderId. Returns the resolved
 * record or null if not found.
 */
export function updateMaxFavorableExcursion({ id, oandaOrderId, currentMfePips, reassessedAt }) {
  if (!Number.isFinite(currentMfePips)) return null;
  const history = loadHistory();
  const idx = history.findIndex(t =>
    (id && t.id === id) ||
    (oandaOrderId && t.oandaOrderId === oandaOrderId)
  );
  if (idx === -1) return null;
  const t = history[idx];
  const prev = Number.isFinite(t.maxFavorableExcursionPips) ? t.maxFavorableExcursionPips : 0;
  if (currentMfePips > prev) t.maxFavorableExcursionPips = +currentMfePips.toFixed(2);
  if (reassessedAt) t.lastReassessedAt = reassessedAt;
  saveHistory(history);
  return t;
}

/**
 * Find an open trade record by OANDA order/trade ID. Used by the reassessor
 * to pull entry-context fields into the management plan.
 */
export function findTradeByBrokerOrderId(oandaOrderId) {
  if (!oandaOrderId) return null;
  const history = loadHistory();
  return history.find(t => t.oandaOrderId === oandaOrderId) || null;
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
    trade.resolvedAt = new Date().toISOString();
    // R-multiple realised on this trade = pnl / riskAmount. Drives the
    // calibration engine's capture-ratio computation.
    const risk = Number.isFinite(trade.riskAmount) ? trade.riskAmount : null;
    if (risk && risk > 0 && Number.isFinite(pnl)) {
      trade.realizedR = Math.round((pnl / risk) * 100) / 100;
    } else {
      trade.realizedR = null;
    }
    saveHistory(history);
    console.log(
      `[TRADE_HISTORY] Resolved trade ${tradeId}: ${result}, PnL: ${pnl}, realizedR: ${trade.realizedR}`,
    );
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
