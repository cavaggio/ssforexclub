/**
 * server/pipMath.js
 *
 * Shared pip-size / pip-distance helpers for the Signal Stack V3 execution
 * engines. Mirrors the (previously private) getPipSize/pricePrecision logic in
 * oandaInstitutionalFlow.js and oandaFibonacci.js so the new engines stay
 * consistent with the existing detectors without duplicating the table.
 */

export function getPipSize(pair) {
  if (String(pair || '').includes('JPY'))       return 0.01;
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return 0.01;
  return 0.0001;
}

export function pricePrecision(pair) {
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return 2;
  if (String(pair || '').includes('JPY'))       return 3;
  return 5;
}

/** Absolute price distance → pips. */
export function toPips(priceDistance, pair) {
  const ps = getPipSize(pair);
  return +(Math.abs(priceDistance) / ps).toFixed(1);
}

/** Pips → price distance. */
export function fromPips(pips, pair) {
  return pips * getPipSize(pair);
}

export function roundPrice(price, pair) {
  const p = pricePrecision(pair);
  return +Number(price).toFixed(p);
}
