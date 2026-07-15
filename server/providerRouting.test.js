import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS,
  assertExecutionProvider,
  CrossProviderExecutionError,
  resolveExecutionClient,
  registerProviderClient,
  _resetProviderRegistry,
  isFuturesProvider,
  isForexProvider,
} from './providerRouting.js';

test('assertExecutionProvider returns the provider when route matches credentials', () => {
  assert.equal(assertExecutionProvider(PROVIDERS.OANDA, 'oanda'), 'oanda');
  assert.equal(assertExecutionProvider(PROVIDERS.NINJATRADER, 'ninjatrader'), 'ninjatrader');
  assert.equal(assertExecutionProvider(PROVIDERS.TOPSTEP, 'topstep'), 'topstep');
  assert.equal(assertExecutionProvider(PROVIDERS.FTMO, 'ftmo'), 'ftmo');
});

test('cross-provider execution is blocked for OANDA and FTMO', () => {
  assert.throws(() => assertExecutionProvider(PROVIDERS.OANDA, 'ftmo'), CrossProviderExecutionError);
  assert.throws(() => assertExecutionProvider(PROVIDERS.FTMO, 'oanda'), CrossProviderExecutionError);
  assert.throws(() => assertExecutionProvider(PROVIDERS.FTMO, 'topstep'), CrossProviderExecutionError);
});

test('futures providers remain isolated', () => {
  assert.throws(() => assertExecutionProvider(PROVIDERS.NINJATRADER, 'oanda'), CrossProviderExecutionError);
  assert.throws(() => assertExecutionProvider(PROVIDERS.TOPSTEP, 'ninjatrader'), CrossProviderExecutionError);
});

test('unknown / missing providers fail closed', () => {
  assert.throws(() => assertExecutionProvider('oanda', undefined), CrossProviderExecutionError);
  assert.throws(() => assertExecutionProvider('bogus', 'bogus'), CrossProviderExecutionError);
  assert.throws(() => assertExecutionProvider(undefined, 'oanda'), CrossProviderExecutionError);
});

test('provider classification keeps forex and futures separate', () => {
  assert.equal(isForexProvider('oanda'), true);
  assert.equal(isForexProvider('ftmo'), true);
  assert.equal(isFuturesProvider('ftmo'), false);
  assert.equal(isFuturesProvider('ninjatrader'), true);
  assert.equal(isFuturesProvider('topstep'), true);
});

test('resolveExecutionClient routes FTMO only to the FTMO factory', () => {
  _resetProviderRegistry();
  registerProviderClient(PROVIDERS.FTMO, (creds) => ({ provider: 'ftmo', creds }));
  registerProviderClient(PROVIDERS.OANDA, (creds) => ({ provider: 'oanda', creds }));

  const client = resolveExecutionClient(PROVIDERS.FTMO, { provider: 'ftmo', accountLogin: '12345678' });
  assert.equal(client.provider, 'ftmo');
  assert.throws(
    () => resolveExecutionClient(PROVIDERS.OANDA, { provider: 'ftmo' }),
    CrossProviderExecutionError,
  );
  _resetProviderRegistry();
});
