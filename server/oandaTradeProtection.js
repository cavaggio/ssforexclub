/**
 * Multi-tenant OANDA profit-protection mutations.
 *
 * This module never closes a trade. It can only tighten the existing stop and,
 * after a partial profit has been taken, remove the fixed TP so the remaining
 * runner can be managed by a trailing protective stop.
 */

import { getOpenTrades, getPricing } from './oandaMarketData.js';
import { getPipSize, pricePrecision } from './pipMath.js';

const finite = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function validateProtectionUpdate({
  trade,
  currentPrice,
  requestedStopLoss,
  cancelTakeProfit = false,
  bufferPips = 1,
} = {}) {
  if (!trade) return { allowed: false, reason: 'Open trade was not found on this broker account.' };
  const instrument = String(trade.instrument || '');
  const units = finite(trade.currentUnits);
  const entryPrice = finite(trade.price);
  const currentStop = finite(trade.stopLossOrder?.price);
  const nextStop = finite(requestedStopLoss);
  const exitPrice = finite(currentPrice);
  const direction = units != null && units < 0 ? 'short' : 'long';
  const pipSize = getPipSize(instrument);
  const priceBuffer = Math.max(0.1, finite(bufferPips) ?? 1) * pipSize;

  if (!instrument || units == null || units === 0 || entryPrice == null) {
    return { allowed: false, reason: 'Broker trade is missing instrument, units, or entry price.' };
  }
  if (exitPrice == null) return { allowed: false, reason: 'Fresh executable price is required before changing protection.' };
  if (nextStop == null && !cancelTakeProfit) {
    return { allowed: false, reason: 'No stop improvement or runner TP cancellation was requested.' };
  }

  let stopLoss = null;
  let stopSkippedReason = null;
  if (nextStop != null) {
    const atOrBeyondBreakeven = direction === 'long'
      ? nextStop >= entryPrice
      : nextStop <= entryPrice;
    if (!atOrBeyondBreakeven) {
      return { allowed: false, reason: 'Automatic protection cannot place a stop on the losing side of breakeven.' };
    }

    const improvesCurrent = currentStop == null || (direction === 'long'
      ? nextStop > currentStop
      : nextStop < currentStop);
    if (improvesCurrent) {
      const behindMarket = direction === 'long'
        ? nextStop < exitPrice - priceBuffer
        : nextStop > exitPrice + priceBuffer;
      if (!behindMarket) {
        return { allowed: false, reason: 'Requested stop is not safely behind the fresh executable price.' };
      }
      stopLoss = nextStop;
    } else {
      stopSkippedReason = 'Requested stop does not improve the current broker stop; it will not be moved backwards.';
    }
  }

  if (stopLoss == null && !cancelTakeProfit) {
    return { allowed: true, noop: true, reason: stopSkippedReason };
  }

  return {
    allowed: true,
    noop: false,
    instrument,
    direction,
    entryPrice,
    currentPrice: exitPrice,
    currentStopLoss: currentStop,
    stopLoss,
    cancelTakeProfit: cancelTakeProfit === true,
    stopSkippedReason,
  };
}

export async function updateBrokerTradeProtection({
  tradeId,
  instrument = null,
  stopLoss = null,
  cancelTakeProfit = false,
  client,
}, {
  getOpen = getOpenTrades,
  getPrices = getPricing,
} = {}) {
  if (!client) throw new Error('updateBrokerTradeProtection: per-request client is required');
  if (!tradeId) throw new Error('updateBrokerTradeProtection: tradeId is required');

  const openTrades = await getOpen({ client });
  const trade = (openTrades || []).find((item) => String(item.id) === String(tradeId));
  if (!trade) return { ok: false, error: 'Open trade was not found on this broker account.', tradeId };
  if (instrument && String(trade.instrument) !== String(instrument)) {
    return { ok: false, error: 'Trade instrument does not match the requested protection update.', tradeId };
  }

  const prices = await getPrices([trade.instrument], { client });
  const quote = (prices || []).find((item) => item.instrument === trade.instrument) || prices?.[0];
  const isLong = Number(trade.currentUnits) > 0;
  const executablePrice = isLong ? finite(quote?.bid) : finite(quote?.ask);
  const validation = validateProtectionUpdate({
    trade,
    currentPrice: executablePrice,
    requestedStopLoss: stopLoss,
    cancelTakeProfit,
    bufferPips: Number(process.env.AUTO_MANAGEMENT_STOP_BUFFER_PIPS || 1),
  });
  if (!validation.allowed) return { ok: false, error: validation.reason, tradeId, validation };
  if (validation.noop) {
    return { ok: true, action: 'protection_unchanged', tradeId, instrument: trade.instrument, validation };
  }

  const body = {};
  if (Number.isFinite(validation.stopLoss)) {
    body.stopLoss = {
      price: Number(validation.stopLoss).toFixed(pricePrecision(trade.instrument)),
      timeInForce: 'GTC',
    };
  }
  if (validation.cancelTakeProfit) body.takeProfit = null;

  try {
    const response = await client.put(
      `/v3/accounts/${client.accountId}/trades/${tradeId}/orders`,
      body,
    );
    return {
      ok: true,
      action: validation.cancelTakeProfit ? 'runner_protection_updated' : 'stop_loss_tightened',
      tradeId: String(tradeId),
      instrument: trade.instrument,
      stopLoss: validation.stopLoss,
      takeProfitCancelled: validation.cancelTakeProfit,
      validation,
      raw: response,
    };
  } catch (error) {
    return {
      ok: false,
      tradeId: String(tradeId),
      instrument: trade.instrument,
      error: error?.message || String(error),
      validation,
    };
  }
}
