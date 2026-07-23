/**
 * ICT scanner watchlist configuration.
 *
 * The ICT engine now trades and studies exactly four pairs. Stale environment
 * variables are intentionally prevented from silently reintroducing the prior
 * broader universe.
 */

export const DEFAULT_ICT_WATCHLIST = Object.freeze([
  'EUR_USD',
  'GBP_USD',
  'USD_JPY',
  'GBP_JPY',
]);

export function configuredIctWatchlist() {
  return [...DEFAULT_ICT_WATCHLIST];
}
