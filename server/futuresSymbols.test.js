import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isFuturesSymbol,
  getFuturesContract,
  toProviderSymbol,
  FUTURES_ROOTS,
} from './futuresSymbols.js';

test('futures symbols are recognized, forex pairs are not', () => {
  assert.equal(isFuturesSymbol('ES'), true);
  assert.equal(isFuturesSymbol('mnq'), true);     // case-insensitive
  assert.equal(isFuturesSymbol('EUR_USD'), false); // forex pair must not be a futures symbol
  assert.equal(isFuturesSymbol('GBP_JPY'), false);
  assert.equal(isFuturesSymbol(null), false);
});

test('contract metadata is available for sizing', () => {
  const es = getFuturesContract('ES');
  assert.equal(es.tickValue, 12.5);
  assert.equal(es.exchange, 'CME');
  assert.ok(FUTURES_ROOTS.includes('MES'));
});

test('toProviderSymbol maps known roots and rejects unknown / non-futures providers', () => {
  assert.equal(toProviderSymbol('ninjatrader', 'ES'), 'ES');
  assert.equal(toProviderSymbol('topstep', 'NQ'), 'NQ');
  assert.throws(() => toProviderSymbol('ninjatrader', 'EUR_USD'), /Unknown futures symbol/);
  assert.throws(() => toProviderSymbol('oanda', 'ES'), /does not trade futures/);
});
