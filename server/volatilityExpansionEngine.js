/**
 * server/volatilityExpansionEngine.js
 *
 * Signal Stack V3 — Volatility Regime / Expansion Detector (priority #4).
 *
 *   analyzeVolatilityExpansion({ pair, candles, atrPips, atrHistorical })
 *
 * Identifies COMPRESSION before EXPANSION so the engine can position before the
 * major move rather than chasing one that has already travelled. This is the
 * core of the "enter earlier" objective.
 *
 * Output:
 *   {
 *     volatilityState,       // 'compressed' | 'expanding' | 'expanded' | 'normal'
 *     compressionDetected,   // boolean — coiled, range contracting
 *     expansionDetected,     // boolean — range/ATR just broke out
 *     volatilityScore,       // 0–100: FAVORS compression→expansion, penalises extended
 *     reasons: []
 *   }
 *
 * Reuses detectAtrExpansion() from oandaInstitutionalFlow.js for the expansion
 * trigger; computes range compression locally.
 */

import { detectAtrExpansion } from './oandaInstitutionalFlow.js';

const SHORT_WIN = 5;
const LONG_WIN = 20;

function trueRanges(candles) {
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return tr;
}

function avg(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }

export function analyzeVolatilityExpansion({ pair, candles = [], atrPips = null, atrHistorical = null } = {}) {
  const reasons = [];

  if (!Array.isArray(candles) || candles.length < LONG_WIN + 2) {
    // Fall back to the ATR ratio if candles are thin but ATRs were supplied.
    if (Number.isFinite(atrPips) && Number.isFinite(atrHistorical) && atrHistorical > 0) {
      const ratio = atrPips / atrHistorical;
      const compressionDetected = ratio <= 0.85;
      const expansionDetected = ratio >= 1.4;
      const volatilityState = expansionDetected ? 'expanded' : compressionDetected ? 'compressed' : 'normal';
      return {
        volatilityState,
        compressionDetected,
        expansionDetected,
        volatilityScore: scoreFor(volatilityState, compressionDetected, expansionDetected),
        reasons: [`ATR-ratio fallback ${(ratio * 100).toFixed(0)}% → ${volatilityState}.`],
      };
    }
    return {
      volatilityState: 'normal',
      compressionDetected: false,
      expansionDetected: false,
      volatilityScore: 50,
      reasons: ['Insufficient candles for volatility analysis — assuming normal.'],
    };
  }

  const tr = trueRanges(candles);
  const shortTr = tr.slice(-SHORT_WIN);
  const priorTr = tr.slice(-(SHORT_WIN + LONG_WIN), -SHORT_WIN);
  const shortAtr = avg(shortTr);
  const priorAtr = avg(priorTr);
  const ratio = priorAtr > 0 ? shortAtr / priorAtr : 1;

  // Range compression: recent N-bar span small relative to the prior window's
  // average bar range (Bollinger-squeeze-style, computed on raw ranges).
  const recentSpan = Math.max(...candles.slice(-SHORT_WIN).map((c) => c.high)) -
                     Math.min(...candles.slice(-SHORT_WIN).map((c) => c.low));
  const priorAvgBar = avg(candles.slice(-(SHORT_WIN + LONG_WIN), -SHORT_WIN).map((c) => c.high - c.low));
  const spanRatio = priorAvgBar > 0 ? recentSpan / (priorAvgBar * SHORT_WIN) : 1;

  // Expansion trigger — reuse the production ATR-expansion detector.
  const atrExp = detectAtrExpansion({ candles });

  const compressionDetected = ratio <= 0.85 || spanRatio <= 0.6;
  const expansionDetected = Boolean(atrExp) || ratio >= 1.4;

  // Was the market compressed just before the latest few bars? (expanding = the
  // transition we most want to catch).
  const wasCompressed = priorAtr > 0 && (avg(tr.slice(-(SHORT_WIN + 3), -SHORT_WIN)) / priorAtr) <= 0.9;

  // Already-extended: ATR high AND price has travelled a long directional run.
  const directionalRun = Math.abs(candles[candles.length - 1].close - candles[candles.length - SHORT_WIN].open);
  const extended = expansionDetected && shortAtr > 0 && (directionalRun / shortAtr) >= 4;

  let volatilityState;
  if (expansionDetected && (wasCompressed || compressionDetected) && !extended) {
    volatilityState = 'expanding';
    reasons.push('Volatility breaking out of compression — prime "enter early" window.');
  } else if (expansionDetected && extended) {
    volatilityState = 'expanded';
    reasons.push('Volatility already expanded and price has travelled far — late, avoid chasing.');
  } else if (expansionDetected) {
    volatilityState = 'expanded';
    reasons.push('Volatility expanded.');
  } else if (compressionDetected) {
    volatilityState = 'compressed';
    reasons.push('Range compressed / ATR contracting — coiled, breakout pending.');
  } else {
    volatilityState = 'normal';
    reasons.push('Volatility normal.');
  }
  if (atrExp) reasons.push(atrExp.reason);

  return {
    volatilityState,
    compressionDetected,
    expansionDetected,
    volatilityScore: scoreFor(volatilityState, compressionDetected, expansionDetected),
    reasons,
  };
}

// Score the regime by tradeability under the "enter early" doctrine.
function scoreFor(state, compression, expansion) {
  switch (state) {
    case 'expanding': return 90;  // breakout from compression — best
    case 'compressed': return 78; // coiled — favourable, anticipate the move
    case 'expanded': return 25;   // already moved — avoid chasing
    default: return 50;
  }
}
