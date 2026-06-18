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
});

test('OANDA route cannot execute NinjaTrader or Topstep credentials', () => {
  assert.throws(() => assertExecutionProvider(PROVIDERS.OANDA, 'ninjatrader'), CrossProviderExecutionError);
  assert.throws(() => assertExecutionProvider(PROVIDERS.OANDA, 'topstep'), CrossProviderExecutionError);
});

test('NinjaTrader route cannot execute OANDA or Topstep credentials', () => {
  assert.throws(() => assertExecutionProvider(PROVIDERS.NINJATRADER, 'oanda'), CrossProviderExecutionError);
  assert.throws(() => assertExecutionProvider(PROVIDERS.NINJATRADER, 'topstep'), CrossProviderExecutionError);
});

test('Topstep route cannot execute OANDA or NinjaTrader credentials', () => {
  assert.throws(() => assertExecutionProvider(PROVIDERS.TOPSTEP, 'oanda'), CrossProviderExecutionError);
  assert.throws(() => assertExecutionProvider(PROVIDERS.TOPSTEP, 'ninjatrader'), CrossProviderExecutionError);
});

test('unknown / missing providers fail closed', () => {
  assert.throws(() => assertExecutionProvider('oanda', undefined), CrossProviderExecutionError);
  assert.throws(() => assertExecutionProvider('bogus', 'bogus'), CrossProviderExecutionError);
  assert.throws(() => assertExecutionProvider(undefined, 'oanda'), CrossProviderExecutionError);
});

test('provider classification keeps forex and futures separate', () => {
  assert.equal(isForexProvider('oanda'), true);
  assert.equal(isFuturesProvider('oanda'), false);
  assert.equal(isFuturesProvider('ninjatrader'), true);
  assert.equal(isFuturesProvider('topstep'), true);
  assert.equal(isForexProvider('ninjatrader'), false);
});

test('resolveExecutionClient routes to the matching factory and blocks cross-provider', () => {
  _resetProviderRegistry();
  registerProviderClient(PROVIDERS.NINJATRADER, (creds) => ({ provider: 'ninjatrader', creds }));
  registerProviderClient(PROVIDERS.OANDA, (creds) => ({ provider: 'oanda', creds }));

  const ntClient = resolveExecutionClient(PROVIDERS.NINJATRADER, { provider: 'ninjatrader', x: 1 });
  assert.equal(ntClient.provider, 'ninjatrader');

  // An OANDA route handed NinjaTrader credentials must throw before any client is built.
  assert.throws(
    () => resolveExecutionClient(PROVIDERS.OANDA, { provider: 'ninjatrader' }),
    CrossProviderExecutionError,
  );
  _resetProviderRegistry();
});
