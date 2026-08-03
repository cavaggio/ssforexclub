/**
 * ICT scanner watchlist configuration.
 *
 * The four FX pairs remain eligible for the existing OANDA execution path.
 * Gold and the two US index instruments are signal-only: the ICT Intelligence
 * tab analyses them from an independent market-data feed, but the OANDA
 * executor and Auto AI must never submit orders for them.
 */

export const ICT_EXECUTABLE_WATCHLIST = Object.freeze([
  'EUR_USD',
  'GBP_USD',
  'USD_JPY',
  'GBP_JPY',
]);

export const ICT_ANALYSIS_ONLY_WATCHLIST = Object.freeze([
  'XAU_USD',
  'US30_USD',
  'SPX500_USD',
]);

export const DEFAULT_ICT_WATCHLIST = Object.freeze([
  ...ICT_EXECUTABLE_WATCHLIST,
  ...ICT_ANALYSIS_ONLY_WATCHLIST,
]);

export function configuredIctWatchlist() {
  return [...DEFAULT_ICT_WATCHLIST];
}

export function isIctAnalysisOnlyInstrument(instrument) {
  return ICT_ANALYSIS_ONLY_WATCHLIST.includes(String(instrument || '').trim().toUpperCase());
}

export function isIctExecutionEligibleInstrument(instrument) {
  return ICT_EXECUTABLE_WATCHLIST.includes(String(instrument || '').trim().toUpperCase());
}
