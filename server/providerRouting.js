/**
 * The single guard that keeps broker providers from cross-executing.
 * FTMO is a separate forex execution provider backed by an MT5 bridge; it must
 * never reuse OANDA credentials or clients.
 */

export const PROVIDERS = Object.freeze({
  OANDA: 'oanda',
  NINJATRADER: 'ninjatrader',
  TOPSTEP: 'topstep',
  FTMO: 'ftmo',
});

export const ALL_PROVIDERS = Object.freeze(Object.values(PROVIDERS));
export const FOREX_PROVIDERS = Object.freeze([PROVIDERS.OANDA, PROVIDERS.FTMO]);
export const FUTURES_PROVIDERS = Object.freeze([PROVIDERS.NINJATRADER, PROVIDERS.TOPSTEP]);

export class CrossProviderExecutionError extends Error {
  constructor(routeProvider, credentialProvider) {
    super(
      `Cross-provider execution blocked: a ${String(routeProvider)} route cannot ` +
      `execute against ${String(credentialProvider)} credentials.`,
    );
    this.name = 'CrossProviderExecutionError';
    this.code = 'CROSS_PROVIDER_BLOCKED';
    this.routeProvider = routeProvider;
    this.credentialProvider = credentialProvider;
  }
}

export function isKnownProvider(p) {
  return ALL_PROVIDERS.includes(p);
}

export function isFuturesProvider(p) {
  return FUTURES_PROVIDERS.includes(p);
}

export function isForexProvider(p) {
  return FOREX_PROVIDERS.includes(p);
}

export function assertExecutionProvider(routeProvider, credentialProvider) {
  if (!isKnownProvider(routeProvider)) {
    throw new CrossProviderExecutionError(routeProvider, credentialProvider);
  }
  if (!isKnownProvider(credentialProvider)) {
    throw new CrossProviderExecutionError(routeProvider, credentialProvider);
  }
  if (routeProvider !== credentialProvider) {
    throw new CrossProviderExecutionError(routeProvider, credentialProvider);
  }
  return routeProvider;
}

const _factories = new Map();

export function registerProviderClient(provider, factory) {
  if (!isKnownProvider(provider)) throw new Error(`registerProviderClient: unknown provider "${provider}"`);
  if (typeof factory !== 'function') throw new Error('registerProviderClient: factory must be a function');
  _factories.set(provider, factory);
}

export function resolveExecutionClient(routeProvider, credentials = {}) {
  assertExecutionProvider(routeProvider, credentials.provider);
  const factory = _factories.get(routeProvider);
  if (!factory) throw new Error(`No execution client registered for provider "${routeProvider}"`);
  return factory(credentials);
}

export function _resetProviderRegistry() {
  _factories.clear();
}
