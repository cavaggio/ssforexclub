/**
 * server/futuresSymbols.js
 *
 * Futures instrument catalog — kept entirely separate from the forex pair list
 * so a futures contract can never be confused with (or routed as) a forex pair.
 *
 * Each entry maps a canonical root symbol to the per-provider contract symbol
 * and the contract's tick metadata (used for risk sizing on the futures side,
 * NOT the forex pip math). Continuous-contract notation is used; the active
 * front-month is resolved by the provider connector at order time.
 */

export const FUTURES_CONTRACTS = Object.freeze({
  ES:  { root: 'ES',  name: 'E-mini S&P 500',        exchange: 'CME',   tickSize: 0.25,  tickValue: 12.50, currency: 'USD' },
  MES: { root: 'MES', name: 'Micro E-mini S&P 500',  exchange: 'CME',   tickSize: 0.25,  tickValue: 1.25,  currency: 'USD' },
  NQ:  { root: 'NQ',  name: 'E-mini Nasdaq-100',      exchange: 'CME',   tickSize: 0.25,  tickValue: 5.00,  currency: 'USD' },
  MNQ: { root: 'MNQ', name: 'Micro E-mini Nasdaq-100', exchange: 'CME',  tickSize: 0.25,  tickValue: 0.50,  currency: 'USD' },
  YM:  { root: 'YM',  name: 'E-mini Dow',             exchange: 'CBOT',  tickSize: 1.0,   tickValue: 5.00,  currency: 'USD' },
  MYM: { root: 'MYM', name: 'Micro E-mini Dow',       exchange: 'CBOT',  tickSize: 1.0,   tickValue: 0.50,  currency: 'USD' },
  RTY: { root: 'RTY', name: 'E-mini Russell 2000',    exchange: 'CME',   tickSize: 0.10,  tickValue: 5.00,  currency: 'USD' },
  M2K: { root: 'M2K', name: 'Micro E-mini Russell',   exchange: 'CME',   tickSize: 0.10,  tickValue: 0.50,  currency: 'USD' },
  CL:  { root: 'CL',  name: 'Crude Oil',              exchange: 'NYMEX', tickSize: 0.01,  tickValue: 10.00, currency: 'USD' },
  MCL: { root: 'MCL', name: 'Micro Crude Oil',        exchange: 'NYMEX', tickSize: 0.01,  tickValue: 1.00,  currency: 'USD' },
  GC:  { root: 'GC',  name: 'Gold',                   exchange: 'COMEX', tickSize: 0.10,  tickValue: 10.00, currency: 'USD' },
  MGC: { root: 'MGC', name: 'Micro Gold',             exchange: 'COMEX', tickSize: 0.10,  tickValue: 1.00,  currency: 'USD' },
});

export const FUTURES_ROOTS = Object.freeze(Object.keys(FUTURES_CONTRACTS));

/** True for a recognized futures root (case-insensitive). Forex pairs return false. */
export function isFuturesSymbol(symbol) {
  if (typeof symbol !== 'string') return false;
  return Object.prototype.hasOwnProperty.call(FUTURES_CONTRACTS, symbol.trim().toUpperCase());
}

export function getFuturesContract(symbol) {
  if (!isFuturesSymbol(symbol)) return null;
  return FUTURES_CONTRACTS[symbol.trim().toUpperCase()];
}

/**
 * Provider-specific contract symbol resolution.
 *   - NinjaTrader uses the bare root (front month resolved by the platform feed).
 *   - Topstep / ProjectX uses the root and resolves the active contract id via
 *     its contract search API; we hand off the root and let the connector map it.
 * Throws on an unknown symbol so a bad instrument can never silently pass.
 */
export function toProviderSymbol(provider, symbol) {
  const c = getFuturesContract(symbol);
  if (!c) throw new Error(`Unknown futures symbol "${symbol}" — not in the futures catalog`);
  switch (provider) {
    case 'ninjatrader':
      return c.root;
    case 'topstep':
      return c.root;
    default:
      throw new Error(`toProviderSymbol: provider "${provider}" does not trade futures`);
  }
}
