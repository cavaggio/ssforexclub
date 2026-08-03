/**
 * Canonical metadata for ICT Intelligence instruments.
 *
 * FX pairs continue to use the authenticated OANDA feed and may use the
 * existing OANDA execution route. XAU/USD, US30 and US500 are analysis-only
 * and use liquid futures contracts as market-data proxies so a US OANDA
 * account is not required to expose CFDs or precious metals.
 */

const DEFAULT_META = Object.freeze({
  displaySymbol: null,
  assetClass: 'forex',
  dataSource: 'oanda',
  sourceSymbol: null,
  sourceLabel: 'OANDA',
  executionEligible: true,
  pricePrecision: 5,
  pointSize: 0.0001,
});

export const ICT_INSTRUMENT_CATALOG = Object.freeze({
  EUR_USD: Object.freeze({ displaySymbol: 'EUR/USD', assetClass: 'forex', dataSource: 'oanda', sourceLabel: 'OANDA', executionEligible: true, pricePrecision: 5, pointSize: 0.0001 }),
  GBP_USD: Object.freeze({ displaySymbol: 'GBP/USD', assetClass: 'forex', dataSource: 'oanda', sourceLabel: 'OANDA', executionEligible: true, pricePrecision: 5, pointSize: 0.0001 }),
  USD_JPY: Object.freeze({ displaySymbol: 'USD/JPY', assetClass: 'forex', dataSource: 'oanda', sourceLabel: 'OANDA', executionEligible: true, pricePrecision: 3, pointSize: 0.01 }),
  GBP_JPY: Object.freeze({ displaySymbol: 'GBP/JPY', assetClass: 'forex', dataSource: 'oanda', sourceLabel: 'OANDA', executionEligible: true, pricePrecision: 3, pointSize: 0.01 }),

  // Signal-only instruments. The futures symbols are market-data proxies, not
  // broker execution symbols, and must never be passed to the OANDA executor.
  XAU_USD: Object.freeze({ displaySymbol: 'XAU/USD', assetClass: 'metal', dataSource: 'yahoo', sourceSymbol: 'GC=F', sourceLabel: 'COMEX Gold futures proxy', executionEligible: false, pricePrecision: 2, pointSize: 0.01 }),
  US30_USD: Object.freeze({ displaySymbol: 'US30', assetClass: 'index', dataSource: 'yahoo', sourceSymbol: 'YM=F', sourceLabel: 'Dow futures proxy', executionEligible: false, pricePrecision: 0, pointSize: 1 }),
  SPX500_USD: Object.freeze({ displaySymbol: 'US500', assetClass: 'index', dataSource: 'yahoo', sourceSymbol: 'ES=F', sourceLabel: 'S&P 500 futures proxy', executionEligible: false, pricePrecision: 2, pointSize: 0.25 }),
});

export function getIctInstrumentMeta(instrument) {
  const key = String(instrument || '').trim().toUpperCase();
  const configured = ICT_INSTRUMENT_CATALOG[key];
  if (configured) return { instrument: key, ...configured };

  const jpy = key.includes('JPY');
  return {
    instrument: key,
    ...DEFAULT_META,
    displaySymbol: key.replace('_', '/'),
    pricePrecision: jpy ? 3 : DEFAULT_META.pricePrecision,
    pointSize: jpy ? 0.01 : DEFAULT_META.pointSize,
  };
}

export function ictDisplaySymbol(instrument) {
  return getIctInstrumentMeta(instrument).displaySymbol;
}

export function isIctExecutionEligible(instrument) {
  return getIctInstrumentMeta(instrument).executionEligible === true;
}
