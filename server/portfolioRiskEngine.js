/**
 * server/portfolioRiskEngine.js
 *
 * Signal Stack V3 — Portfolio Risk Engine (ADDITIVE, analysis-only).
 *
 *   analyzePortfolioRisk({ openTrades, accountBalance, accountEquity }) → report
 *   currencyExposureFromTrades(openTrades) → net per-currency exposure
 *   pairCorrelation(a, b) → -1..1 heuristic correlation between two pairs
 *
 * Looks across the set of currently-open trades and surfaces aggregate risk the
 * per-trade sizing logic can't see: stacked same-currency exposure, correlated
 * positions doubling a bet, directional lopsidedness, and total "heat".
 *
 * IMPORTANT — this NEVER opens, closes, resizes, or blocks a trade. It is a
 * read-only advisory consumed by the dashboard / AI panel. The existing
 * execution, sizing, and reassessment paths are untouched.
 *
 * Tolerant input: each open trade may use any of these field names —
 *   pair | instrument | symbol
 *   direction | side          ('long'/'short'/'buy'/'sell')
 *   riskUSD | actualRiskUSD | riskAmount | targetRiskUSD
 *   units | tradeUnits
 *   unrealizedPL | unrealized_pl | pnl
 */

const HIGH_HEAT = parseFloat(process.env.PORTFOLIO_HIGH_HEAT_PERCENT || '6');   // % equity at risk → high
const MED_HEAT  = parseFloat(process.env.PORTFOLIO_MED_HEAT_PERCENT  || '3');   // % equity at risk → medium
const CONCENTRATION_HIGH = 0.6; // one currency holding >60% of net exposure → concentrated

function firstDefined(obj, keys) {
  for (const k of keys) if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  return null;
}
function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function normDir(v) {
  const s = String(v || '').toLowerCase();
  if (s === 'long' || s === 'buy') return 'long';
  if (s === 'short' || s === 'sell') return 'short';
  return null;
}
function splitPair(pair) {
  const norm = String(pair || '').replace('/', '_').toUpperCase();
  const parts = norm.split('_');
  if (parts.length !== 2) return null;
  return { base: parts[0], quote: parts[1] };
}

function normalizeTrade(t) {
  if (!t || typeof t !== 'object') return null;
  const pair = firstDefined(t, ['pair', 'instrument', 'symbol']);
  const legs = splitPair(pair);
  if (!legs) return null;
  const direction = normDir(firstDefined(t, ['direction', 'side']));
  const riskUSD = toNum(firstDefined(t, ['riskUSD', 'actualRiskUSD', 'riskAmount', 'targetRiskUSD']));
  const units = toNum(firstDefined(t, ['units', 'tradeUnits']));
  const unrealizedPL = toNum(firstDefined(t, ['unrealizedPL', 'unrealized_pl', 'pnl']));
  return { pair: `${legs.base}_${legs.quote}`, base: legs.base, quote: legs.quote, direction, riskUSD, units, unrealizedPL };
}

/**
 * Net exposure per currency, in risk units (USD risk when available, else a
 * unit weight of 1 per position). Long pair = +base / -quote; short = inverse.
 */
export function currencyExposureFromTrades(openTrades) {
  const exposure = {};
  for (const raw of Array.isArray(openTrades) ? openTrades : []) {
    const t = normalizeTrade(raw);
    if (!t || !t.direction) continue;
    const w = t.riskUSD != null ? Math.abs(t.riskUSD) : 1;
    const sign = t.direction === 'long' ? 1 : -1;
    exposure[t.base] = (exposure[t.base] || 0) + sign * w;
    exposure[t.quote] = (exposure[t.quote] || 0) - sign * w;
  }
  // Round for display.
  for (const k of Object.keys(exposure)) exposure[k] = +exposure[k].toFixed(2);
  return exposure;
}

// Heuristic FX correlation: pairs sharing a currency in a reinforcing way are
// positively/negatively correlated. Exact values matter less than the sign and
// rough magnitude — this is advisory only.
export function pairCorrelation(a, b) {
  const pa = splitPair(a), pb = splitPair(b);
  if (!pa || !pb) return 0;
  if (pa.base === pb.base && pa.quote === pb.quote) return 1;
  // Shared base (e.g. EUR_USD vs EUR_JPY) → positively correlated.
  if (pa.base === pb.base) return 0.6;
  // Shared quote (e.g. EUR_USD vs GBP_USD) → positively correlated.
  if (pa.quote === pb.quote) return 0.6;
  // Base of one == quote of other (e.g. EUR_USD vs USD_JPY) → negatively correlated.
  if (pa.base === pb.quote || pa.quote === pb.base) return -0.5;
  return 0;
}

function classifyCorrelationRisk(trades) {
  const clusters = [];
  const warnings = [];
  for (let i = 0; i < trades.length; i++) {
    for (let j = i + 1; j < trades.length; j++) {
      const a = trades[i], b = trades[j];
      if (!a.direction || !b.direction) continue;
      const corr = pairCorrelation(a.pair, b.pair);
      if (corr === 0) continue;
      // Same direction + positive correlation, OR opposite direction + negative
      // correlation → the two positions REINFORCE the same underlying bet.
      const sameDir = a.direction === b.direction;
      const reinforcing = (corr > 0 && sameDir) || (corr < 0 && !sameDir);
      if (reinforcing && Math.abs(corr) >= 0.5) {
        clusters.push({ pairs: [a.pair, b.pair], directions: [a.direction, b.direction], correlation: corr });
      }
    }
  }
  let correlationRisk = 'low';
  if (clusters.length >= 3) correlationRisk = 'high';
  else if (clusters.length >= 1) correlationRisk = 'medium';
  if (clusters.length) {
    warnings.push(
      `${clusters.length} correlated position pair(s) detected — e.g. ${clusters[0].pairs.join(' & ')} ` +
      `(${clusters[0].directions.join('/')}) effectively compound the same bet.`,
    );
  }
  return { clusters, correlationRisk, warnings };
}

/**
 * analyzePortfolioRisk(input) → {
 *   openPositions, totalOpenRiskUSD, totalOpenRiskPercent,
 *   netUnrealizedPL, currencyExposure, topExposure,
 *   correlationClusters, correlationRisk,
 *   directionalBias, portfolioHeat, heatLevel,
 *   warnings, recommendation
 * }
 *
 * Always returns a valid report; never throws.
 */
export function analyzePortfolioRisk({ openTrades = [], accountBalance = null, accountEquity = null } = {}) {
  const equity = toNum(accountEquity) ?? toNum(accountBalance);
  const trades = (Array.isArray(openTrades) ? openTrades : []).map(normalizeTrade).filter(Boolean);

  const empty = {
    openPositions: 0,
    totalOpenRiskUSD: 0,
    totalOpenRiskPercent: null,
    netUnrealizedPL: 0,
    currencyExposure: {},
    topExposure: null,
    correlationClusters: [],
    correlationRisk: 'low',
    directionalBias: { long: 0, short: 0, net: 'flat' },
    portfolioHeat: 0,
    heatLevel: 'low',
    warnings: [],
    recommendation: 'No open positions — portfolio risk is flat.',
  };
  if (trades.length === 0) return empty;

  const totalOpenRiskUSD = +trades.reduce((sum, t) => sum + (t.riskUSD != null ? Math.abs(t.riskUSD) : 0), 0).toFixed(2);
  const netUnrealizedPL = +trades.reduce((sum, t) => sum + (t.unrealizedPL || 0), 0).toFixed(2);
  const totalOpenRiskPercent = equity && equity > 0 ? +((totalOpenRiskUSD / equity) * 100).toFixed(2) : null;

  const currencyExposure = currencyExposureFromTrades(openTrades);
  const expEntries = Object.entries(currencyExposure).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const topExposure = expEntries.length ? { currency: expEntries[0][0], net: expEntries[0][1] } : null;
  const totalAbsExposure = expEntries.reduce((s, [, v]) => s + Math.abs(v), 0);
  const concentration = totalAbsExposure > 0 && topExposure ? Math.abs(topExposure.net) / totalAbsExposure : 0;

  const longs = trades.filter((t) => t.direction === 'long').length;
  const shorts = trades.filter((t) => t.direction === 'short').length;
  const directionalBias = {
    long: longs,
    short: shorts,
    net: longs > shorts ? 'long-skewed' : shorts > longs ? 'short-skewed' : 'balanced',
  };

  const { clusters, correlationRisk, warnings } = classifyCorrelationRisk(trades);

  // Portfolio heat: blend of capital-at-risk and structural concentration.
  let heat = 0;
  if (totalOpenRiskPercent != null) {
    heat = Math.min(100, (totalOpenRiskPercent / HIGH_HEAT) * 60); // 60 pts at the high threshold
  } else {
    heat = Math.min(60, trades.length * 12); // no equity: proxy by position count
  }
  heat += concentration >= CONCENTRATION_HIGH ? 25 : concentration >= 0.4 ? 12 : 0;
  heat += correlationRisk === 'high' ? 15 : correlationRisk === 'medium' ? 8 : 0;
  const portfolioHeat = Math.max(0, Math.min(100, Math.round(heat)));

  let heatLevel = 'low';
  if (totalOpenRiskPercent != null) {
    if (totalOpenRiskPercent >= HIGH_HEAT || portfolioHeat >= 75) heatLevel = 'high';
    else if (totalOpenRiskPercent >= MED_HEAT || portfolioHeat >= 45) heatLevel = 'medium';
  } else if (portfolioHeat >= 70) heatLevel = 'high';
  else if (portfolioHeat >= 40) heatLevel = 'medium';

  if (concentration >= CONCENTRATION_HIGH && topExposure) {
    warnings.push(
      `Concentrated exposure: ${topExposure.currency} accounts for ${Math.round(concentration * 100)}% of net open exposure — diversification is thin.`,
    );
  }
  if (totalOpenRiskPercent != null && totalOpenRiskPercent >= HIGH_HEAT) {
    warnings.push(`Total open risk is ${totalOpenRiskPercent}% of equity (≥ ${HIGH_HEAT}% threshold) — consider trimming before adding.`);
  }

  const recommendation = buildRecommendation({ heatLevel, correlationRisk, directionalBias, topExposure, concentration });

  return {
    openPositions: trades.length,
    totalOpenRiskUSD,
    totalOpenRiskPercent,
    netUnrealizedPL,
    currencyExposure,
    topExposure,
    correlationClusters: clusters,
    correlationRisk,
    directionalBias,
    portfolioHeat,
    heatLevel,
    warnings,
    recommendation,
  };
}

function buildRecommendation({ heatLevel, correlationRisk, directionalBias, topExposure, concentration }) {
  if (heatLevel === 'high') {
    return 'High portfolio heat — avoid adding new risk; consider scaling out of the weakest position before opening anything new.';
  }
  if (correlationRisk === 'high') {
    return 'Multiple correlated positions are compounding the same bet — treat them as one trade for risk purposes and avoid stacking further.';
  }
  if (concentration >= CONCENTRATION_HIGH && topExposure) {
    return `Exposure is concentrated in ${topExposure.currency} — diversify the next entry into an uncorrelated pair rather than adding to the same theme.`;
  }
  if (heatLevel === 'medium') {
    return 'Moderate portfolio heat — room for selective additions, but size new entries conservatively.';
  }
  if (directionalBias.net !== 'balanced') {
    return `Book is ${directionalBias.net} (${directionalBias.long}L/${directionalBias.short}S) — fine while heat is low, but watch for a single macro move hitting everything at once.`;
  }
  return 'Portfolio risk is healthy and diversified — normal position-taking is fine.';
}
