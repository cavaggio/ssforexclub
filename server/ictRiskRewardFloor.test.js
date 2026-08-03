import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ICT_MIN_RR, enforceMinimumRRTarget } from './ictEngine.js';
import { maybeRebaseIctTarget, selectIctPairQuote } from './ictExecutionTarget.js';

test('ICT target floor extends a low-RR long setup to 1.5R', () => {
  assert.equal(ICT_MIN_RR, 1.5);

  const result = enforceMinimumRRTarget({
    pair: 'USD_CHF',
    direction: 'long',
    entry: 0.81244,
    stopLoss: 0.81184,
    target: 0.81290,
    minRR: 1.5,
  });

  assert.equal(result.ok, true);
  assert.equal(result.target, 0.81334);
  assert.equal(result.rr, 1.5);
  assert.equal(result.adjusted, true);
});

test('ICT target floor extends a low-RR short setup to 1.5R', () => {
  const result = enforceMinimumRRTarget({
    pair: 'EUR_USD',
    direction: 'short',
    entry: 1.10000,
    stopLoss: 1.10100,
    target: 1.09950,
    minRR: 1.5,
  });

  assert.equal(result.ok, true);
  assert.equal(result.target, 1.09850);
  assert.equal(result.rr, 1.5);
  assert.equal(result.adjusted, true);
});

test('ICT target floor preserves a natural target already above 1.5R', () => {
  const result = enforceMinimumRRTarget({
    pair: 'EUR_USD',
    direction: 'long',
    entry: 1.10000,
    stopLoss: 1.09900,
    target: 1.10200,
    minRR: 1.5,
  });

  assert.equal(result.ok, true);
  assert.equal(result.target, 1.10200);
  assert.equal(result.rr, 2);
  assert.equal(result.adjusted, false);
});

test('ICT target floor remains valid after instrument price rounding', () => {
  const result = enforceMinimumRRTarget({
    pair: 'XAU_USD',
    direction: 'long',
    entry: 2400.00,
    stopLoss: 2399.99,
    target: 2400.01,
    minRR: 1.5,
  });

  assert.equal(result.ok, true);
  assert.ok(result.rr >= 1.5);
  assert.ok(result.target > 2400.01);
});

test('executable target rebase fixes the EUR/USD 1.51R to 1.29R spread case', () => {
  const result = maybeRebaseIctTarget({
    pair: 'EUR_USD',
    direction: 'long',
    executablePrice: 1.15261,
    stopLoss: 1.15192,
    currentTarget: 1.15350,
    scannerRR: 1.51,
    executableRR: 1.29,
    minimumRR: 1.5,
    maxExtensionPips: 5,
  });

  assert.equal(result.adjusted, true);
  assert.equal(result.targetProfit, 1.15365);
  assert.ok(result.rebasedRR >= 1.5);
  assert.equal(result.extensionPips, 1.5);
  assert.equal(result.pair, 'EUR_USD');
});

test('executable target rebase mirrors correctly for a short pair', () => {
  const result = maybeRebaseIctTarget({
    pair: 'EUR/USD',
    direction: 'short',
    executablePrice: 1.10010,
    stopLoss: 1.10080,
    currentTarget: 1.09920,
    scannerRR: 1.5,
    executableRR: 1.29,
    minimumRR: 1.5,
    maxExtensionPips: 5,
  });

  assert.equal(result.adjusted, true);
  assert.equal(result.targetProfit, 1.09905);
  assert.ok(result.rebasedRR >= 1.5);
  assert.equal(result.pair, 'EUR_USD');
});

test('a genuine excessive target extension remains rejected with the pair named', () => {
  const result = maybeRebaseIctTarget({
    pair: 'EUR_USD',
    direction: 'long',
    executablePrice: 1.10100,
    stopLoss: 1.10000,
    currentTarget: 1.10150,
    scannerRR: 1.5,
    executableRR: 0.5,
    minimumRR: 1.5,
    maxExtensionPips: 5,
  });

  assert.equal(result.adjusted, false);
  assert.equal(result.reason, 'target_extension_exceeds_cap');
  assert.match(result.blocker, /^EUR_USD requires a /);
  assert.match(result.blocker, /execution cap$/);
});

test('fresh quote selection uses the requested pair instead of prices[0]', () => {
  const result = selectIctPairQuote({
    prices: [
      { instrument: 'GBP_USD', bids: [{ price: '1.30000' }], asks: [{ price: '1.30020' }] },
      { instrument: 'EUR_USD', bids: [{ price: '1.15250' }], asks: [{ price: '1.15261' }] },
    ],
  }, 'EUR/USD');

  assert.equal(result.ok, true);
  assert.equal(result.quote.instrument, 'EUR_USD');
  assert.equal(result.matchedBy, 'instrument');
  assert.equal(result.candidateCount, 2);
});

test('fresh quote selection rejects a mismatched instrument with pair-specific detail', () => {
  const result = selectIctPairQuote({
    prices: [{ instrument: 'GBP_USD', bids: [{ price: '1.30000' }], asks: [{ price: '1.30020' }] }],
  }, 'EUR_USD');

  assert.equal(result.ok, false);
  assert.match(result.reason, /EUR_USD/);
  assert.match(result.reason, /GBP_USD/);
});
