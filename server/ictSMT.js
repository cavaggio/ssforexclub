/**
 * server/ictSMT.js
 *
 * ICT Engine — SMT (Smart Money Technique) divergence, FX-only.
 *
 * True ICT SMT compares correlated assets (EUR/USD vs GBP/USD, ES vs NQ,
 * XAU/USD vs DXY). Index/futures (ES, NQ, DXY) aren't on the OANDA FX feed, so
 * this implementation uses POSITIVELY-correlated FX pairs and degrades
 * gracefully to `smtDetected:false, 'comparison asset unavailable'` when no
 * usable peer's candles are supplied.
 *
 * Divergence logic (positively-correlated peers):
 *   - Bearish SMT: target makes a HIGHER high (sweeps buy-side) but the peer
 *     FAILS to make a higher high → smart money distributing.
 *   - Bullish SMT: target makes a LOWER low (sweeps sell-side) but the peer
 *     FAILS to make a lower low → smart money accumulating.
 */

import { roundPrice } from './pipMath.js';

// Positively-correlated FX groups (members move together vs the USD).
const CORR_GROUPS = [
  ['EUR_USD', 'GBP_USD', 'AUD_USD', 'NZD_USD', 'XAU_USD', 'XAG_USD'], // USD-quoted
  ['USD_JPY', 'USD_CHF', 'USD_CAD'],                                  // USD-base
];

export function correlatedPeers(pair) {
  const group = CORR_GROUPS.find((g) => g.includes(pair));
  return group ? group.filter((p) => p !== pair) : [];
}

// Recent vs prior swing extreme over a small window.
function windows(candles, win = 6) {
  if (!Array.isArray(candles) || candles.length < win * 2) return null;
  const recent = candles.slice(-win);
  const prior = candles.slice(-win * 2, -win);
  return {
    recentHigh: Math.max(...recent.map((c) => c.high)),
    recentLow: Math.min(...recent.map((c) => c.low)),
    priorHigh: Math.max(...prior.map((c) => c.high)),
    priorLow: Math.min(...prior.map((c) => c.low)),
  };
}

/**
 * @param {string} pair
 * @param {Array} candles            target pair candles (e.g. M15)
 * @param {Object<string,Array>} peers  { PAIR: candles } for correlated pairs
 */
export function detectSMT({ pair, candles, peers = {} }) {
  const blank = (note) => ({ smtDetected: false, comparisonAsset: null, direction: null, liquidityLevel: null, note });

  const tw = windows(candles);
  if (!tw) return blank('insufficient candles');

  // Pick the first correlated peer that has usable candles.
  const peerName = correlatedPeers(pair).find((p) => Array.isArray(peers[p]) && peers[p].length >= 12);
  if (!peerName) return blank('comparison asset unavailable');

  const pw = windows(peers[peerName]);
  if (!pw) return blank('comparison asset unavailable');

  // Bearish SMT: target made a higher high, peer did not.
  const targetHH = tw.recentHigh > tw.priorHigh;
  const peerHH = pw.recentHigh > pw.priorHigh;
  if (targetHH && !peerHH) {
    return { smtDetected: true, comparisonAsset: peerName, direction: 'bearish', liquidityLevel: roundPrice(tw.recentHigh, pair), note: `${pair} swept buy-side; ${peerName} failed to make a higher high.` };
  }

  // Bullish SMT: target made a lower low, peer did not.
  const targetLL = tw.recentLow < tw.priorLow;
  const peerLL = pw.recentLow < pw.priorLow;
  if (targetLL && !peerLL) {
    return { smtDetected: true, comparisonAsset: peerName, direction: 'bullish', liquidityLevel: roundPrice(tw.recentLow, pair), note: `${pair} swept sell-side; ${peerName} failed to make a lower low.` };
  }

  return { smtDetected: false, comparisonAsset: peerName, direction: null, liquidityLevel: null, note: 'no divergence' };
}
