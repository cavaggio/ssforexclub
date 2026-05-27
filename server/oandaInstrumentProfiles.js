/**
 * server/oandaInstrumentProfiles.js
 *
 * Instrument-aware tuning. Different asset classes need different thresholds
 * — metals have wider spreads and 50-pip swings on noise; indices trend hard
 * during NY but range during Asia; major forex pairs need tight SL or the
 * R:R math doesn't work.
 *
 *   getInstrumentProfile(pair)  →  Profile
 *
 * Profile fields:
 *   assetClass            'Forex' | 'Metal' | 'Index'
 *   maxSpreadPips         pre-trade reject above this
 *   maxSpreadPctOfTp      0–1; reject if spread > this fraction of TP pips
 *   atrThresholdMin       minimum ATR to consider trading
 *   atrThresholdHigh      ATR above this triggers "high vol" sizing
 *   slMultiplier          [min, max] × ATR
 *   tpMultiplier          [min, max] × ATR (capped by R:R + key levels)
 *   minConfidence         absolute floor for the aggregate confidence
 *   minCandleStrength     0–100 floor on the analyzeCandleStrength score
 *   preferredSessions     []  — confidence bonus when scan runs in one of these
 *   allowedMarketStates   []  — hard reject if classifier returns something not in this list
 *   notes                 free-text — for the dashboard
 */

const PROFILE_BY_PAIR = {
  // ── Major forex pairs ─────────────────────────────────────────────────────
  EUR_USD: { assetClass: 'Forex', maxSpreadPips: 3,  maxSpreadPctOfTp: 0.15, atrThresholdMin: 4,  atrThresholdHigh: 18, slMultiplier: [1.0, 1.5], tpMultiplier: [2.0, 3.5], minConfidence: 25, minCandleStrength: 45, preferredSessions: ['London', 'NewYork', 'London/NewYork Overlap'], allowedMarketStates: ['TRENDING','BREAKOUT','REVERSAL_RISK'], notes: 'Tight ranges, NY/London preferred.' },
  GBP_USD: { assetClass: 'Forex', maxSpreadPips: 4,  maxSpreadPctOfTp: 0.18, atrThresholdMin: 5,  atrThresholdHigh: 25, slMultiplier: [1.0, 1.6], tpMultiplier: [2.0, 3.5], minConfidence: 25, minCandleStrength: 45, preferredSessions: ['London', 'NewYork', 'London/NewYork Overlap'], allowedMarketStates: ['TRENDING','BREAKOUT','REVERSAL_RISK'], notes: 'Volatile London open.' },
  USD_JPY: { assetClass: 'Forex', maxSpreadPips: 5,  maxSpreadPctOfTp: 0.20, atrThresholdMin: 5,  atrThresholdHigh: 22, slMultiplier: [1.0, 1.5], tpMultiplier: [2.0, 3.5], minConfidence: 25, minCandleStrength: 45, preferredSessions: ['Tokyo/London Overlap', 'NewYork'], allowedMarketStates: ['TRENDING','BREAKOUT','REVERSAL_RISK'], notes: 'Strong intervention risk on big moves.' },
  AUD_USD: { assetClass: 'Forex', maxSpreadPips: 5,  maxSpreadPctOfTp: 0.20, atrThresholdMin: 4,  atrThresholdHigh: 18, slMultiplier: [1.0, 1.6], tpMultiplier: [1.8, 3.0], minConfidence: 28, minCandleStrength: 50, preferredSessions: ['NewYork', 'Sydney/Tokyo Overlap'], allowedMarketStates: ['TRENDING','BREAKOUT'] },
  USD_CAD: { assetClass: 'Forex', maxSpreadPips: 6,  maxSpreadPctOfTp: 0.20, atrThresholdMin: 5,  atrThresholdHigh: 22, slMultiplier: [1.0, 1.6], tpMultiplier: [2.0, 3.5], minConfidence: 25, minCandleStrength: 45, preferredSessions: ['NewYork'], allowedMarketStates: ['TRENDING','BREAKOUT'] },
  USD_CHF: { assetClass: 'Forex', maxSpreadPips: 6,  maxSpreadPctOfTp: 0.22, atrThresholdMin: 4,  atrThresholdHigh: 18, slMultiplier: [1.0, 1.5], tpMultiplier: [2.0, 3.0], minConfidence: 28, minCandleStrength: 48, preferredSessions: ['London','NewYork'], allowedMarketStates: ['TRENDING','BREAKOUT'] },
  NZD_USD: { assetClass: 'Forex', maxSpreadPips: 6,  maxSpreadPctOfTp: 0.22, atrThresholdMin: 4,  atrThresholdHigh: 18, slMultiplier: [1.0, 1.5], tpMultiplier: [1.8, 3.0], minConfidence: 28, minCandleStrength: 50, preferredSessions: ['NewYork'], allowedMarketStates: ['TRENDING','BREAKOUT'] },

  // JPY crosses
  GBP_JPY: { assetClass: 'Forex', maxSpreadPips: 12, maxSpreadPctOfTp: 0.20, atrThresholdMin: 10, atrThresholdHigh: 45, slMultiplier: [1.2, 1.8], tpMultiplier: [2.0, 3.5], minConfidence: 30, minCandleStrength: 50, preferredSessions: ['London','NewYork','London/NewYork Overlap'], allowedMarketStates: ['TRENDING','BREAKOUT'], notes: 'Wide ranges, demands wider SL.' },
  EUR_JPY: { assetClass: 'Forex', maxSpreadPips: 10, maxSpreadPctOfTp: 0.20, atrThresholdMin: 8,  atrThresholdHigh: 40, slMultiplier: [1.1, 1.8], tpMultiplier: [2.0, 3.5], minConfidence: 30, minCandleStrength: 50, preferredSessions: ['London','NewYork','Tokyo/London Overlap'], allowedMarketStates: ['TRENDING','BREAKOUT'] },

  // ── Metals ────────────────────────────────────────────────────────────────
  XAU_USD: { assetClass: 'Metal', maxSpreadPips: 50, maxSpreadPctOfTp: 0.20, atrThresholdMin: 25, atrThresholdHigh: 120, slMultiplier: [1.4, 2.4], tpMultiplier: [2.5, 4.5], minConfidence: 35, minCandleStrength: 55, preferredSessions: ['London','NewYork','London/NewYork Overlap'], allowedMarketStates: ['TRENDING','BREAKOUT','REVERSAL_RISK'], notes: 'Strong rejection-detection required; metals fake-break often.' },
  XAG_USD: { assetClass: 'Metal', maxSpreadPips: 40, maxSpreadPctOfTp: 0.22, atrThresholdMin: 18, atrThresholdHigh: 90,  slMultiplier: [1.4, 2.4], tpMultiplier: [2.0, 4.0], minConfidence: 38, minCandleStrength: 55, preferredSessions: ['London','NewYork'], allowedMarketStates: ['TRENDING','BREAKOUT'] },

  // ── Indices ───────────────────────────────────────────────────────────────
  // OANDA uses NAS100_USD / US30_USD / SPX500_USD. Pip size = 1.0.
  NAS100_USD: { assetClass: 'Index', maxSpreadPips: 8,  maxSpreadPctOfTp: 0.15, atrThresholdMin: 40, atrThresholdHigh: 200, slMultiplier: [1.0, 1.8], tpMultiplier: [2.0, 4.0], minConfidence: 30, minCandleStrength: 55, preferredSessions: ['NewYork','London/NewYork Overlap'], allowedMarketStates: ['TRENDING','BREAKOUT'], notes: 'NY session weighted, prefers breakout/retest.' },
  US30_USD:   { assetClass: 'Index', maxSpreadPips: 6,  maxSpreadPctOfTp: 0.15, atrThresholdMin: 35, atrThresholdHigh: 160, slMultiplier: [1.0, 1.8], tpMultiplier: [2.0, 3.5], minConfidence: 30, minCandleStrength: 55, preferredSessions: ['NewYork','London/NewYork Overlap'], allowedMarketStates: ['TRENDING','BREAKOUT'], notes: 'NY session weighted.' },
  SPX500_USD: { assetClass: 'Index', maxSpreadPips: 4,  maxSpreadPctOfTp: 0.15, atrThresholdMin: 8,  atrThresholdHigh: 40,  slMultiplier: [1.0, 1.6], tpMultiplier: [2.0, 3.5], minConfidence: 30, minCandleStrength: 55, preferredSessions: ['NewYork','London/NewYork Overlap'], allowedMarketStates: ['TRENDING','BREAKOUT'] },
  DE30_EUR:   { assetClass: 'Index', maxSpreadPips: 6,  maxSpreadPctOfTp: 0.15, atrThresholdMin: 30, atrThresholdHigh: 130, slMultiplier: [1.0, 1.8], tpMultiplier: [2.0, 3.5], minConfidence: 30, minCandleStrength: 55, preferredSessions: ['London','London/NewYork Overlap'], allowedMarketStates: ['TRENDING','BREAKOUT'] },
  UK100_GBP:  { assetClass: 'Index', maxSpreadPips: 4,  maxSpreadPctOfTp: 0.15, atrThresholdMin: 20, atrThresholdHigh: 90,  slMultiplier: [1.0, 1.6], tpMultiplier: [1.8, 3.0], minConfidence: 30, minCandleStrength: 55, preferredSessions: ['London','London/NewYork Overlap'], allowedMarketStates: ['TRENDING','BREAKOUT'] },
};

const ALIAS = {
  // Common short forms in case the scanner watchlist uses them
  NAS100: 'NAS100_USD',
  US30:   'US30_USD',
  SPX500: 'SPX500_USD',
  XAUUSD: 'XAU_USD',
  XAGUSD: 'XAG_USD',
};

function defaultForex() {
  return {
    assetClass: 'Forex',
    maxSpreadPips: 6,
    maxSpreadPctOfTp: 0.22,
    atrThresholdMin: 4,
    atrThresholdHigh: 22,
    slMultiplier: [1.0, 1.6],
    tpMultiplier: [1.8, 3.0],
    minConfidence: 28,
    minCandleStrength: 45,
    preferredSessions: ['London', 'NewYork', 'London/NewYork Overlap'],
    allowedMarketStates: ['TRENDING', 'BREAKOUT'],
    notes: 'Default forex profile (no pair-specific entry).',
  };
}

export function getInstrumentProfile(pair) {
  if (!pair) return defaultForex();
  const norm = String(pair).replace('/', '_').toUpperCase();
  const aliased = ALIAS[norm] || norm;
  const profile = PROFILE_BY_PAIR[aliased];
  if (profile) return { ...profile, pair: aliased };
  // Fallback: detect asset class heuristically
  if (aliased.startsWith('XAU_') || aliased.startsWith('XAG_')) {
    return { ...PROFILE_BY_PAIR.XAU_USD, pair: aliased, notes: 'Metals fallback profile' };
  }
  if (aliased.startsWith('NAS100') || aliased.startsWith('US30') ||
      aliased.startsWith('SPX500') || aliased.startsWith('DE30') ||
      aliased.startsWith('UK100')) {
    return { ...PROFILE_BY_PAIR.US30_USD, pair: aliased, notes: 'Index fallback profile' };
  }
  return { ...defaultForex(), pair: aliased };
}

export function listKnownInstruments() {
  return Object.keys(PROFILE_BY_PAIR);
}
