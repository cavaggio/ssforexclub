/**
 * server/oandaExitManager.js
 * Server-side automated exit management for open OANDA trades.
 * Runs entirely on a backend interval — no frontend, no browser tab required.
 *
 * Monitors every open trade and applies:
 *   A. Breakeven stop move at +BREAK_EVEN_TRIGGER_PIPS
 *   B. Event-driven 50% partial at +PARTIAL_CLOSE_TRIGGER_PIPS (polling is disconnect fallback only)
 *   C. Trailing stop on remaining 50% runner
 *   D. Final-exit logging when trade disappears from open list
 */

import { getAccountId, oandaGet, oandaPut } from './oandaClient.js';
import { getPricing } from './oandaMarketData.js';
import {
  getImmediatePartialTradeState,
  markImmediatePartialTaken,
  syncImmediatePartialTrades,
  getImmediatePartialStatus,
} from './oandaImmediatePartial.js';

// ─── Config ───────────────────────────────────────────────────────────────────
const BREAK_EVEN_TRIGGER_PIPS       = 10;
const PARTIAL_CLOSE_TRIGGER_PIPS    = 15.0;
const PARTIAL_CLOSE_PERCENT         = 0.50;
const DEFAULT_TRAILING_DISTANCE_PIPS = 10;
const MONITOR_INTERVAL_MS           = 30_000;

// ─── In-memory state per open trade ──────────────────────────────────────────
// Keyed by OANDA tradeId. Cleared when the trade no longer appears in open list.
const tradeState = new Map();
// shape: { beMoveDone, partialTaken, trailingActive, trailingStopLevel, maxProfitPips }

let intervalHandle = null;

// ─── Instrument helpers ───────────────────────────────────────────────────────

function getPipSize(instrument) {
  if (instrument.includes('JPY'))                            return 0.01;
  if (instrument === 'XAU_USD' || instrument === 'XAG_USD') return 0.01;
  return 0.0001;
}

function getPriceDecimals(instrument) {
  if (instrument === 'XAU_USD' || instrument === 'XAG_USD') return 2;
  if (instrument.includes('JPY'))                            return 3;
  return 5;
}

function pipToPrice(pips, instrument) {
  return pips * getPipSize(instrument);
}

function priceToPips(distance, instrument) {
  return Math.abs(distance) / getPipSize(instrument);
}

function getTrailingDistancePips(instrument) {
  // Wider trail for naturally volatile crosses
  if (instrument.includes('GBP') || instrument.includes('JPY')) return 12;
  return DEFAULT_TRAILING_DISTANCE_PIPS;
}

function initTradeState(tradeId) {
  if (!tradeState.has(tradeId)) {
    tradeState.set(tradeId, {
      beMoveDone:        false,
      partialTaken:      false,
      trailingActive:    false,
      trailingStopLevel: null,
      maxProfitPips:     0,
    });
  }
  return tradeState.get(tradeId);
}

// ─── OANDA API calls ──────────────────────────────────────────────────────────

async function fetchOpenTrades() {
  const accountId = getAccountId();
  const data = await oandaGet(`/v3/accounts/${accountId}/trades?state=OPEN`);
  return data.trades || [];
}

/**
 * Partially close a trade by specifying the number of units to close.
 * OANDA expects a positive integer regardless of trade direction.
 */
async function partialClosePosition(tradeId, unitsToClose) {
  const accountId = getAccountId();
  const safe = Math.max(1, Math.round(Math.abs(unitsToClose)));
  return oandaPut(
    `/v3/accounts/${accountId}/trades/${tradeId}/close`,
    { units: String(safe) }
  );
}

async function modifyStopLoss(tradeId, newStopPrice, instrument) {
  const accountId = getAccountId();
  const decimals  = getPriceDecimals(instrument);
  return oandaPut(
    `/v3/accounts/${accountId}/trades/${tradeId}/orders`,
    { stopLoss: { price: newStopPrice.toFixed(decimals), timeInForce: 'GTC' } }
  );
}

// ─── Per-trade exit logic ─────────────────────────────────────────────────────

async function applyExitRules(trade, currentPrice) {
  const {
    id:           tradeId,
    instrument,
    price:        entryPriceStr,
    currentUnits: currentUnitsStr,
    stopLossOrder,
  } = trade;

  const entryPrice   = parseFloat(entryPriceStr);
  const currentUnits = parseInt(currentUnitsStr, 10);
  const isLong       = currentUnits > 0;
  const totalUnits   = Math.abs(currentUnits);

  const state = initTradeState(tradeId);

  // Profit in pips from entry
  const priceDiff  = isLong ? (currentPrice - entryPrice) : (entryPrice - currentPrice);
  const profitPips = priceDiff / getPipSize(instrument);

  // Track high-water mark
  if (profitPips > state.maxProfitPips) state.maxProfitPips = profitPips;

  const currentStop = stopLossOrder ? parseFloat(stopLossOrder.price) : null;

  // ── A. Breakeven protection ──────────────────────────────────────────────────
  if (!state.beMoveDone && profitPips >= BREAK_EVEN_TRIGGER_PIPS) {
    const bePrice = entryPrice;
    const shouldMove = currentStop === null
      || (isLong  && bePrice > currentStop)
      || (!isLong && bePrice < currentStop);

    if (shouldMove) {
      try {
        await modifyStopLoss(tradeId, bePrice, instrument);
        state.beMoveDone = true;
        console.log('[OANDA_EXIT_BE_MOVE]', {
          tradeId, instrument,
          direction: isLong ? 'LONG' : 'SHORT',
          from: currentStop,
          to:   bePrice,
          profitPips: +profitPips.toFixed(1),
        });
      } catch (err) {
        console.error('[OANDA_EXIT_BE_MOVE] Failed to move stop to breakeven:', err.message);
      }
    }
  }

  // ── B. Event-driven partial; polling is stream-disconnect fallback only ─────────────
  const immediatePartial = getImmediatePartialTradeState({
    accountId: getAccountId(),
    tradeId,
  });
  if (!state.partialTaken && immediatePartial?.partialTaken) {
    state.partialTaken = true;
    state.trailingActive = true;
    console.log('[OANDA_PARTIAL_CLOSE_50] synchronized from pricing stream', {
      tradeId,
      instrument,
      maxProfitPips: immediatePartial.maxProfitPips,
      lastPartialAt: immediatePartial.lastPartialAt,
    });
  }

  const streamOwnsTrigger = immediatePartial?.connected === true || immediatePartial?.partialInFlight === true;
  if (!state.partialTaken && !streamOwnsTrigger && profitPips >= PARTIAL_CLOSE_TRIGGER_PIPS) {
    console.warn('[OANDA_PARTIAL_CLOSE_50] pricing stream unavailable — using 30s safety fallback', {
      tradeId, instrument, profitPips: +profitPips.toFixed(1),
    });
    if (totalUnits < 2) {
      state.partialTaken   = true;
      state.trailingActive = true;
      markImmediatePartialTaken({ accountId: getAccountId(), tradeId, currentUnits });
      console.log('[OANDA_PARTIAL_CLOSE_50] Skipped — position too small to split', { tradeId, totalUnits });
    } else {
      const unitsToClose = Math.max(1, Math.min(
        Math.round(totalUnits * PARTIAL_CLOSE_PERCENT),
        totalUnits - 1
      ));
      const remaining = totalUnits - unitsToClose;
      try {
        await partialClosePosition(tradeId, unitsToClose);
        state.partialTaken   = true;
        state.trailingActive = true;
        const signedRemaining = (isLong ? 1 : -1) * remaining;
        markImmediatePartialTaken({ accountId: getAccountId(), tradeId, currentUnits: signedRemaining });
        console.log('[OANDA_PARTIAL_CLOSE_50]', {
          tradeId, instrument,
          direction:    isLong ? 'LONG' : 'SHORT',
          totalUnits,
          closedUnits:  unitsToClose,
          runnerUnits:  remaining,
          profitPips:   +profitPips.toFixed(1),
          source:       'polling_disconnect_fallback',
        });
      } catch (err) {
        console.error('[OANDA_PARTIAL_CLOSE_50] Failed:', err.message);
      }
    }
  }

  // ── C. Trailing stop on the remaining 50% runner ──────────────────────────────
  if (state.trailingActive) {
    const trailPips = getTrailingDistancePips(instrument);
    const trailDist = pipToPrice(trailPips, instrument);

    let newTrail;
    if (isLong) {
      newTrail = currentPrice - trailDist;
      // Only tighten — never move stop back down
      if (state.trailingStopLevel === null || newTrail > state.trailingStopLevel) {
        const prevLevel = state.trailingStopLevel;
        state.trailingStopLevel = newTrail;
        try {
          await modifyStopLoss(tradeId, newTrail, instrument);
          console.log('[OANDA_TRAILING_STOP_UPDATE]', {
            tradeId, instrument, direction: 'LONG',
            prev:     prevLevel !== null ? +prevLevel.toFixed(getPriceDecimals(instrument)) : null,
            newStop:  +newTrail.toFixed(getPriceDecimals(instrument)),
            trailPips,
          });
        } catch (err) {
          console.error('[OANDA_TRAILING_STOP_UPDATE] Failed:', err.message);
        }
      }
    } else {
      newTrail = currentPrice + trailDist;
      // Only tighten — never move stop back up
      if (state.trailingStopLevel === null || newTrail < state.trailingStopLevel) {
        const prevLevel = state.trailingStopLevel;
        state.trailingStopLevel = newTrail;
        try {
          await modifyStopLoss(tradeId, newTrail, instrument);
          console.log('[OANDA_TRAILING_STOP_UPDATE]', {
            tradeId, instrument, direction: 'SHORT',
            prev:     prevLevel !== null ? +prevLevel.toFixed(getPriceDecimals(instrument)) : null,
            newStop:  +newTrail.toFixed(getPriceDecimals(instrument)),
            trailPips,
          });
        } catch (err) {
          console.error('[OANDA_TRAILING_STOP_UPDATE] Failed:', err.message);
        }
      }
    }
  }
}

// ─── Main monitor loop ────────────────────────────────────────────────────────

async function monitorOpenTrades() {
  let openTrades;
  try {
    openTrades = await fetchOpenTrades();
  } catch (err) {
    console.error('[EXIT_MANAGER] Could not fetch open trades:', err.message);
    return;
  }

  // Reconcile the event-driven +15 pip stream from the broker snapshot.
  // This call discovers/re-discovers open trades, but PRICE events — not this
  // 30-second loop — own the live partial trigger while the stream is connected.
  syncImmediatePartialTrades(openTrades);

  if (!openTrades.length) {
    return; // Nothing to monitor
  }

  // Fetch live mid prices for all instruments in one batch call
  const instruments = [...new Set(openTrades.map((t) => t.instrument))];
  let pricingMap = {};
  try {
    const prices = await getPricing(instruments);
    for (const p of prices) pricingMap[p.instrument] = p;
  } catch (err) {
    console.error('[EXIT_MANAGER] Could not fetch pricing:', err.message);
    return;
  }

  // Detect trades that have closed since last tick and log final exit
  const openIds = new Set(openTrades.map((t) => t.id));
  for (const id of tradeState.keys()) {
    if (!openIds.has(id)) {
      console.log('[OANDA_FINAL_EXIT]', {
        tradeId: id,
        reason:  'Trade no longer in OANDA open trades list',
        state:   tradeState.get(id),
      });
      tradeState.delete(id);
    }
  }

  // Apply exit rules to each open trade
  for (const trade of openTrades) {
    const pricing = pricingMap[trade.instrument];
    if (!pricing) {
      console.warn('[EXIT_MANAGER] No pricing for', trade.instrument);
      continue;
    }

    const isLong = parseInt(trade.currentUnits, 10) > 0;
    // Use bid for long exit evaluation (what we'd sell at), ask for short
    const currentPrice = isLong ? pricing.bid : pricing.ask;

    try {
      await applyExitRules(trade, currentPrice);
    } catch (err) {
      console.error(`[EXIT_MANAGER] Error on trade ${trade.id}:`, err.message);
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function startExitManager() {
  if (intervalHandle) return;
  console.log(`[EXIT_MANAGER] Starting — poll interval: ${MONITOR_INTERVAL_MS / 1000}s`);
  // Run immediately on start, then on interval
  monitorOpenTrades().catch((err) => console.error('[EXIT_MANAGER]', err.message));
  intervalHandle = setInterval(() => {
    monitorOpenTrades().catch((err) => console.error('[EXIT_MANAGER]', err.message));
  }, MONITOR_INTERVAL_MS);
}

export function stopExitManager() {
  if (!intervalHandle) return;
  clearInterval(intervalHandle);
  intervalHandle = null;
  console.log('[EXIT_MANAGER] Stopped.');
}

export function getExitManagerStatus() {
  const trades = [];
  for (const [tradeId, state] of tradeState.entries()) {
    trades.push({
      tradeId,
      beMoveDone:        state.beMoveDone,
      partialTaken:      state.partialTaken,
      trailingActive:    state.trailingActive,
      trailingStopLevel: state.trailingStopLevel,
      maxProfitPips:     state.maxProfitPips,
    });
  }
  return {
    running:        intervalHandle !== null,
    pollIntervalMs: MONITOR_INTERVAL_MS,
    partialTriggerMode: 'oanda_pricing_stream_with_poll_disconnect_fallback',
    immediatePartialStream: getImmediatePartialStatus(),
    trackedTrades:  tradeState.size,
    trades,
  };
}
