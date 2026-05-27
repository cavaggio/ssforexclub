import fetch from 'node-fetch';

const BASE_URL = process.env.ALPACA_BASE_URL;
const API_KEY = process.env.ALPACA_API_KEY;
const API_SECRET = process.env.ALPACA_API_SECRET;

// 🔥 Risk settings
const MAX_RISK_PER_TRADE = 0.1; // 10% of account
const MAX_OPEN_TRADES = 3;

export async function executeTrade(signal) {

  if (!signal.optionSymbol || !signal.limitPrice) {
    return {
      success: false,
      blocked: true,
      blockReason: 'Missing option execution data — signal not dropped, blocked from live order only',
      signal,
    };
  }

  // 1. Get account
  const accountRes = await fetch(`${BASE_URL}/v2/account`, {
    headers: {
      'APCA-API-KEY-ID': API_KEY,
      'APCA-API-SECRET-KEY': API_SECRET,
    }
  });

  const account = await accountRes.json();
  const buyingPower = parseFloat(account.buying_power);

  // 2. Position sizing
  const capitalToUse = buyingPower * MAX_RISK_PER_TRADE;

  const contracts = Math.floor(capitalToUse / (signal.limitPrice * 100));

  if (contracts <= 0) {
    return { success: false, reason: 'Not enough capital' };
  }

  // 3. Place order
  const order = {
    symbol: signal.optionSymbol,
    qty: contracts,
    side: 'buy',
    type: 'limit',
    limit_price: signal.limitPrice,
    time_in_force: 'day'
  };

  const orderRes = await fetch(`${BASE_URL}/v2/orders`, {
    method: 'POST',
    headers: {
      'APCA-API-KEY-ID': API_KEY,
      'APCA-API-SECRET-KEY': API_SECRET,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(order)
  });

  const orderData = await orderRes.json();

  return {
    success: true,
    order: orderData,
    contracts,
    capitalUsed: contracts * signal.limitPrice * 100
  };
}