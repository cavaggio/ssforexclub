import test from 'node:test';
import assert from 'node:assert/strict';

import { updateBrokerTradeProtection, validateProtectionUpdate } from './oandaTradeProtection.js';

const longTrade = {
  id: 'T-1',
  instrument: 'EUR_USD',
  currentUnits: '100000',
  price: '1.10000',
  stopLossOrder: { price: '1.09800' },
  takeProfitOrder: { price: '1.10300' },
};

test('automatic protection may move a profitable long to breakeven and arm a runner', async () => {
  const calls = [];
  const client = {
    accountId: 'ACC-1',
    put: async (path, body) => { calls.push({ path, body }); return { relatedTransactionIDs: ['1'] }; },
  };
  const result = await updateBrokerTradeProtection({
    tradeId: 'T-1', instrument: 'EUR_USD', stopLoss: 1.10000,
    cancelTakeProfit: true, client,
  }, {
    getOpen: async () => [longTrade],
    getPrices: async () => [{ instrument: 'EUR_USD', bid: 1.10200, ask: 1.10210 }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.takeProfitCancelled, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, {
    stopLoss: { price: '1.10000', timeInForce: 'GTC' },
    takeProfit: null,
  });
});

test('automatic protection refuses to move a stop backwards or below breakeven', () => {
  const belowBreakeven = validateProtectionUpdate({
    trade: longTrade,
    currentPrice: 1.1020,
    requestedStopLoss: 1.0990,
  });
  assert.equal(belowBreakeven.allowed, false);
  assert.match(belowBreakeven.reason, /losing side of breakeven/i);

  const backwards = validateProtectionUpdate({
    trade: { ...longTrade, stopLossOrder: { price: '1.10100' } },
    currentPrice: 1.1020,
    requestedStopLoss: 1.1005,
  });
  assert.equal(backwards.allowed, true);
  assert.equal(backwards.noop, true);
});

test('an existing breakeven stop can keep its position while the fixed TP is removed', () => {
  const result = validateProtectionUpdate({
    trade: { ...longTrade, stopLossOrder: { price: '1.10000' } },
    currentPrice: 1.10005,
    requestedStopLoss: 1.10000,
    cancelTakeProfit: true,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.noop, false);
  assert.equal(result.stopLoss, null);
  assert.equal(result.cancelTakeProfit, true);
});

test('a post-TP runner trail can only tighten behind the current market', async () => {
  const calls = [];
  const client = {
    accountId: 'ACC-1',
    put: async (path, body) => { calls.push({ path, body }); return {}; },
  };
  const result = await updateBrokerTradeProtection({
    tradeId: 'T-1', stopLoss: 1.1025, cancelTakeProfit: true, client,
  }, {
    getOpen: async () => [{ ...longTrade, stopLossOrder: { price: '1.10000' }, takeProfitOrder: null }],
    getPrices: async () => [{ instrument: 'EUR_USD', bid: 1.1040, ask: 1.1041 }],
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].body.stopLoss.price, '1.10250');
  assert.equal(calls[0].body.takeProfit, null);
});
