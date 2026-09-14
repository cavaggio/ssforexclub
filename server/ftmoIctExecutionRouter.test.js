import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FTMO_ICT_EXECUTION_POLICY,
  buildFtmoIctOrderPayload,
  mt5ResultToOandaFill,
} from './ftmoIctExecutionRouter.js';

test('FTMO ICT order payload keeps the production MT5 risk policy', () => {
  const payload = buildFtmoIctOrderPayload({
    pair: 'GBP_JPY',
    direction: 'short',
    signalId: 'ict-gj-1',
  });

  assert.equal(payload.symbol, 'GBP_JPY');
  assert.equal(payload.side, 'sell');
  assert.equal(payload.riskPercent, 1);
  assert.equal(payload.stopPips, 10);
  assert.equal(payload.breakEvenPips, 10);
  assert.equal(payload.firstPartialPips, 15);
  assert.equal(payload.firstPartialPercent, 80);
  assert.equal(payload.finalTakeProfitPips, 18);
  assert.equal(payload.finalPartialPercent, 20);
  assert.equal(payload.source, 'signal-stack-auto-ai');
  assert.equal(payload.testMode, false);
  assert.deepEqual(FTMO_ICT_EXECUTION_POLICY, {
    riskPercent: 1,
    stopPips: 10,
    breakEvenPips: 10,
    firstPartialPips: 15,
    firstPartialPercent: 80,
    finalTakeProfitPips: 18,
    finalPartialPercent: 20,
  });
});

test('resolved MT5 fill is translated to the existing ICT fill contract', () => {
  const fill = mt5ResultToOandaFill({
    order: 101,
    deal: 202,
    positionTicket: 303,
    positionIdentifier: 404,
    price: 198.123,
    volume: 1.25,
    notionalUnits: 125000,
    riskPercent: 1,
    executionResolved: true,
  });

  assert.equal(fill.executionProvider, 'ftmo_mt5_ea');
  assert.equal(fill.orderFillTransaction.tradeOpened.tradeID, '303');
  assert.equal(fill.orderFillTransaction.price, '198.123');
  assert.equal(fill.mt5Execution.order, '101');
  assert.equal(fill.mt5Execution.deal, '202');
  assert.equal(fill.mt5Execution.positionTicket, '303');
  assert.equal(fill.mt5Execution.executionResolved, true);
});

test('unresolved MT5 reports are rejected instead of being treated as fills', () => {
  assert.throws(
    () => mt5ResultToOandaFill({
      order: 101,
      deal: 0,
      positionTicket: 0,
      executionResolved: false,
    }),
    /without resolved broker order\/deal\/position identifiers/,
  );
});
