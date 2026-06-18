/**
 * server/providerRouting.js
 *
 * The single guard that keeps broker providers from cross-executing.
 *
 * Every execution path (OANDA forex, NinjaTrader futures, Topstep futures)
 * resolves an "active provider" for the request and a "credential provider"
 * from the stored connection. Those two MUST match. A futures trade must never
 * be able to route through the OANDA client, and vice-versa.
 *
 * This module is deliberately tiny and dependency-free so it can be unit-tested
 * in isolation and called from any route before any order is built.
 */

export const PROVIDERS = Object.freeze({
  OANDA: 'oanda',
  NINJATRADER: 'ninjatrader',
  TOPSTEP: 'topstep',
});

export const ALL_PROVIDERS = Object.freeze(Object.values(PROVIDERS));

/** Forex lives on OANDA; futures live on NinjaTrader + Topstep. */
export const FOREX_PROVIDERS = Object.freeze([PROVIDERS.OANDA]);
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

/**
 * Throw unless the route's provider exactly matches the credential's provider.
 * Returns the (validated) provider on success so callers can use it inline.
 *
 *   const provider = assertExecutionProvider(PROVIDERS.OANDA, creds.provider);
 *
 * Both arguments are required and must be known providers — an unknown or
 * missing provider fails closed.
 */
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

/**
 * Registry of provider → execution client factory. Routes resolve their client
 * exclusively through here, so a futures route physically cannot obtain the
 * OANDA client. Factories are injected at startup (registerProviderClient) to
 * avoid import cycles between this guard and the heavy client modules.
 */
const _factories = new Map();

export function registerProviderClient(provider, factory) {
  if (!isKnownProvider(provider)) throw new Error(`registerProviderClient: unknown provider "${provider}"`);
  if (typeof factory !== 'function') throw new Error('registerProviderClient: factory must be a function');
  _factories.set(provider, factory);
}

/**
 * Build the execution client for `routeProvider`, asserting the supplied
 * credentials belong to the same provider first. Throws CrossProviderExecutionError
 * on mismatch and a plain Error if no factory is registered for the provider.
 */
export function resolveExecutionClient(routeProvider, credentials = {}) {
  assertExecutionProvider(routeProvider, credentials.provider);
  const factory = _factories.get(routeProvider);
  if (!factory) throw new Error(`No execution client registered for provider "${routeProvider}"`);
  return factory(credentials);
}

/** Test/teardown helper. */
export function _resetProviderRegistry() {
  _factories.clear();
}
