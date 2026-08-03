/**
 * server/pipMath.js
 *
 * Shared pip-size / point-distance helpers for the Signal Stack execution and
 * intelligence engines. Forex continues to use conventional pip sizes. The
 * analysis-only US index proxies use their native point/tick increments.
 */

export function getPipSize(pair) {
  const instrument = String(pair || '').toUpperCase();
  if (instrument === 'US30_USD') return 1;
  if (instrument === 'SPX500_USD') return 0.25;
  if (instrument.includes('JPY')) return 0.01;
  if (instrument === 'XAU_USD' || instrument === 'XAG_USD') return 0.01;
  return 0.0001;
}

export function pricePrecision(pair) {
  const instrument = String(pair || '').toUpperCase();
  if (instrument === 'US30_USD') return 0;
  if (instrument === 'SPX500_USD') return 2;
  if (instrument === 'XAU_USD' || instrument === 'XAG_USD') return 2;
  if (instrument.includes('JPY')) return 3;
  return 5;
}

/** Absolute price distance → pips/points/ticks for the instrument. */
export function toPips(priceDistance, pair) {
  const ps = getPipSize(pair);
  return +(Math.abs(priceDistance) / ps).toFixed(1);
}

/** Pips/points/ticks → price distance. */
export function fromPips(pips, pair) {
  return pips * getPipSize(pair);
}

export function roundPrice(price, pair) {
  const p = pricePrecision(pair);
  return +Number(price).toFixed(p);
}
