import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IMMEDIATE_PARTIAL_TRIGGER_PIPS,
  brokerTradeAlreadyReduced,
  executablePriceForImmediatePartial,
  partialUnitsForImmediateClose,
  profitPipsForImmediatePartial,
} from './oandaImmediatePartial.js';

test('long immediate-partial trigger uses executable bid', () => {
  const pips = profitPipsForImmediatePartial({
    instrument: 'EUR_USD',
    entryPrice: 1.10000,
    currentUnits: 100000,
    bid: 1.10150,
    ask: 1.10162,
  });
  assert.ok(Math.abs(pips - IMMEDIATE_PARTIAL_TRIGGER_PIPS) < 1e-9);
  assert.equal(executablePriceForImmediatePartial({ currentUnits: 100000, bid: 1.1015, ask: 1.10162 }), 1.1015);
});

test('short immediate-partial trigger uses executable ask', () => {
  const pips = profitPipsForImmediatePartial({
    instrument: 'USD_JPY',
    entryPrice: 150.000,
    currentUnits: -100000,
    bid: 149.838,
    ask: 149.850,
  });
  assert.ok(Math.abs(pips - IMMEDIATE_PARTIAL_TRIGGER_PIPS) < 1e-9);
  assert.equal(executablePriceForImmediatePartial({ currentUnits: -100000, bid: 149.838, ask: 149.85 }), 149.85);
});

test('50 percent partial never closes the final unit', () => {
  assert.equal(partialUnitsForImmediateClose(100000), 50000);
  assert.equal(partialUnitsForImmediateClose(-100000), 50000);
  assert.equal(partialUnitsForImmediateClose(2), 1);
  assert.equal(partialUnitsForImmediateClose(1), null);
});

test('broker reduction is recognized before another partial can fire', () => {
  assert.equal(brokerTradeAlreadyReduced(100000, 50000), true);
  assert.equal(brokerTradeAlreadyReduced(-100000, -50000), true);
  assert.equal(brokerTradeAlreadyReduced(100000, 100000), false);
});
