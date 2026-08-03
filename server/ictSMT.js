/**
 * server/ictSMT.js
 *
 * ICT Engine — SMT (Smart Money Technique) divergence.
 *
 * Divergence logic compares positively correlated instruments:
 *   - Bearish SMT: target makes a higher high while its peer does not.
 *   - Bullish SMT: target makes a lower low while its peer does not.
 *
 * Gold can compare with the USD-quoted FX group. US30 and US500 compare with
 * one another through the analysis-only futures proxy candles.
 */

import { roundPrice } from './pipMath.js';

const CORR_GROUPS = [
  ['EUR_USD', 'GBP_USD', 'AUD_USD', 'NZD_USD', 'XAU_USD', 'XAG_USD'],
  ['USD_JPY', 'USD_CHF', 'USD_CAD'],
  ['US30_USD', 'SPX500_USD'],
];

export function correlatedPeers(pair) {
  const group = CORR_GROUPS.find((g) => g.includes(pair));
  return group ? group.filter((p) => p !== pair) : [];
}

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

export function detectSMT({ pair, candles, peers = {} }) {
  const blank = (note) => ({ smtDetected: false, comparisonAsset: null, direction: null, liquidityLevel: null, note });

  const tw = windows(candles);
  if (!tw) return blank('insufficient candles');

  const peerName = correlatedPeers(pair).find((p) => Array.isArray(peers[p]) && peers[p].length >= 12);
  if (!peerName) return blank('comparison asset unavailable');

  const pw = windows(peers[peerName]);
  if (!pw) return blank('comparison asset unavailable');

  const targetHH = tw.recentHigh > tw.priorHigh;
  const peerHH = pw.recentHigh > pw.priorHigh;
  if (targetHH && !peerHH) {
    return {
      smtDetected: true,
      comparisonAsset: peerName,
      direction: 'bearish',
      liquidityLevel: roundPrice(tw.recentHigh, pair),
      note: `${pair} swept buy-side; ${peerName} failed to make a higher high.`,
    };
  }

  const targetLL = tw.recentLow < tw.priorLow;
  const peerLL = pw.recentLow < pw.priorLow;
  if (targetLL && !peerLL) {
    return {
      smtDetected: true,
      comparisonAsset: peerName,
      direction: 'bullish',
      liquidityLevel: roundPrice(tw.recentLow, pair),
      note: `${pair} swept sell-side; ${peerName} failed to make a lower low.`,
    };
  }

  return { smtDetected: false, comparisonAsset: peerName, direction: null, liquidityLevel: null, note: 'no divergence' };
}
