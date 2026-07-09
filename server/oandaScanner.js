import { getRetraceWatchPairs, evaluateRetraceCandidate } from './retraceWatchMode.js';
import { evaluatePrimaryTimeframeAlignment } from './primaryTimeframeAlignment.js';
/**
 * server/oandaScanner.js
 *
 * Institutional multi-timeframe market scanner.
 *
 *   Layer 1 — Macro     (Daily + H4)  → direction & regime
 *   Layer 2 — Structure (H1 + M30)    → continuation vs reversal
 *   Layer 3 — Momentum  (M15 + M5)    → execution trigger
 *   Alignment engine    → folds layers + emits qualified / rejected with reasons
 *   Dynamic sizing       → balance × confidence-scaled risk %, fixed 20p/60p/1:3
 *
 * Indicators (RSI/MACD/EMA/ATR) live inside the momentum layer ONLY. No
 * indicator alone can qualify a trade.
 */

import { getCandles, getPricing, getForexSession } from './oandaMarketData.js';
import { atr } from './oandaIndicators.js';
import { checkMarketConditions, getTypicalSpread } from './oandaRiskMonitor.js';
import { updateSignalStore, setScanInProgress } from './oandaSignalStore.js';
import { getAccountSummary } from './oandaMarketData.js';
import {
  RISK_MODE,
  MIN_RISK_PERCENT,
  MAX_RISK_PERCENT,
  CONFIDENCE_FOR_MAX_RISK,
  DYNAMIC_RISK_NOTICE,
  computeFixedDollarSizing,
  computeDynamicTradeRisk,
} from './oandaRiskSizing.js';
import { computeTradeLifecycle } from './oandaTradeLifecycle.js';
import {
  analyzeMacro,
  analyzeStructure,
  analyzeMomentum,
  computeAlignment,
  computeConfidenceScore,
} from './oandaMtfAnalysis.js';
import { detectFibSetup } from './oandaFibonacci.js';
import { analyzeInstitutionalFlow } from './oandaInstitutionalFlow.js';
import { classifyEntryTiming } from './oandaEntryTiming.js';
import { getForexNewsRisk } from './oandaNewsRisk.js';
import { analyzeRecentCandleStrength } from './oandaCandleStrength.js';
import { classifyMarketState } from './oandaMarketState.js';
import { assessMtfAuthority } from './oandaMtfAuthority.js';
import { classifyOverextension } from './oandaOverextension.js';
import { getInstrumentProfile } from './oandaInstrumentProfiles.js';
import { qualifyByAssetClass } from './oandaAssetClassRouter.js';
import { computeExpectedRR } from './oandaExpectedRR.js';
import { getCalibrationSnapshot } from './oandaCalibration.js';
import { getTradeHistory } from './oandaTradeHistory.js';
// Signal Stack V3 — additive intelligence layers (read-only; never gate qualification)
import { analyzeMacroRisk, analyzeMacroBias } from './macroEngine.js';
import { detectMarketRegime } from './marketRegimeEngine.js';
// Signal Stack V3 — execution engine (liquidity/structure/session/volatility),
// feature-flagged via FOREX_V3_ENGINE_MODE (off|shadow|active). In off/shadow
// it NEVER changes a live trade decision.
import { evaluateV3, isV3Enabled, V3_MODE } from './v3Engine.js';
import { recordV3Shadow, generateV3ComparisonReport } from './v3ShadowLog.js';

// ─── Config ───────────────────────────────────────────────────────────────────
const MIN_CONFIDENCE = parseFloat(process.env.FOREX_MIN_CONFIDENCE || '20');
const MAX_SPREAD_PIPS = parseFloat(process.env.FOREX_MAX_SPREAD_PIPS || '5.0');
const METALS_MAX_SPREAD_PIPS = parseFloat(process.env.METALS_MAX_SPREAD_PIPS || '50');
// Strict mode hard-blocks setups with entryTiming.status==='too_early'.
// HYBRID (default false): only news_blocked + opposing institutional flow
// hard-block; too_early flows through to the dashboard with a warning.
const ENTRY_TIMING_STRICT = String(process.env.FOREX_ENTRY_TIMING_STRICT || 'false').toLowerCase() === 'true';
// Fallback lot size — used only when displaying meta defaults; per-trade lot size
// is computed dynamically per signal, never taken from this constant.
const DEFAULT_DISPLAY_LOT_SIZE = parseFloat(process.env.FOREX_FIXED_LOT_SIZE || '0.01');

// Legacy-scanner log verbosity (does NOT affect scoring, qualification, or any
// trading logic — only which console lines print). silent < warn < info < debug.
// Default 'info' hides the verbose per-pair WATERFALL/scoring/reject spam; set
// SCANNER_LOG_LEVEL=debug to restore full per-pair detail.
const SCANNER_LOG_LEVEL = String(process.env.SCANNER_LOG_LEVEL || 'info').toLowerCase();
const _SLOG_RANK = { silent: 0, warn: 1, info: 2, debug: 3 };
const _SLOG_CUR = _SLOG_RANK[SCANNER_LOG_LEVEL] ?? 2;
const scannerLogEnabled = (level) => (_SLOG_RANK[level] ?? 2) <= _SLOG_CUR;
function slog(level, ...args) { if (scannerLogEnabled(level)) console.log(...args); }

const DEFAULT_FOREX_WATCHLIST = ['EUR_USD', 'USD_CAD', 'AUD_USD', 'NZD_USD', 'USD_CHF', 'EUR_GBP', 'EUR_CHF', 'AUD_CAD'];

const WATCHLIST = process.env.FOREX_WATCHLIST
  ? process.env.FOREX_WATCHLIST.split(',').map(p => p.trim()).filter(Boolean)
  : DEFAULT_FOREX_WATCHLIST;

const WATCHLIST_PRIORITY_ORDER = [
  'EUR_USD',
  'USD_CAD',
  'AUD_USD',
  'NZD_USD',
  'USD_CHF',
  'EUR_GBP',
  'EUR_CHF',
  'AUD_CAD',
];

// Keep the preferred scan order, but never drop valid env/default watchlist pairs.
const ORDERED_WATCHLIST = [
  ...WATCHLIST_PRIORITY_ORDER.filter(pair => WATCHLIST.includes(pair)),
  ...WATCHLIST.filter(pair => !WATCHLIST_PRIORITY_ORDER.includes(pair)),
];

// ─── Instrument helpers ───────────────────────────────────────────────────────


function applyPrimaryTimeframeGate(signalLike, direction) {
  const primary = evaluatePrimaryTimeframeAlignment(signalLike, direction);

  if (!signalLike || typeof signalLike !== 'object') return primary;

  signalLike.primaryTimeframeAlignment = primary;

  if (!Array.isArray(signalLike.warnings)) signalLike.warnings = [];
  if (!Array.isArray(signalLike.rejectionReasons)) signalLike.rejectionReasons = [];

  if (!primary.passed) {
    signalLike.rejectionReasons.push(primary.reason);
  } else if (primary.contextConflicts?.length) {
    signalLike.warnings.push(primary.reason);
    signalLike.rejectionReasons = signalLike.rejectionReasons.filter((r) => {
      const s = String(r || '').toLowerCase();
      return !(
        s.includes('alignment score') ||
        s.includes('timeframe score') ||
        s.includes('h1') ||
        s.includes('m30') ||
        s.includes('m5')
      );
    });
  }

  return primary;
}

export function getPipSize(pair) {
  if (pair.includes('JPY')) return 0.01;
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return 0.01;
  return 0.0001;
}

function isMetalsPair(pair) {
  return pair === 'XAU_USD' || pair === 'XAG_USD';
}

function getInstrumentName(pair) {
  const names = {
    EUR_USD: 'Euro / US Dollar',
    GBP_USD: 'British Pound / US Dollar',
    USD_JPY: 'US Dollar / Japanese Yen',
    USD_CHF: 'US Dollar / Swiss Franc',
    AUD_USD: 'Australian Dollar / US Dollar',
    USD_CAD: 'US Dollar / Canadian Dollar',
    NZD_USD: 'New Zealand Dollar / US Dollar',
    EUR_GBP: 'Euro / British Pound',
    EUR_JPY: 'Euro / Japanese Yen',
    GBP_JPY: 'British Pound / Japanese Yen',
    AUD_JPY: 'Australian Dollar / Japanese Yen',
    EUR_AUD: 'Euro / Australian Dollar',
    GBP_AUD: 'British Pound / Australian Dollar',
    XAU_USD: 'Gold',
    XAG_USD: 'Silver',
  };
  return names[pair] || pair.replace('_', '/');
}

function getAssetClass(pair) {
  return isMetalsPair(pair) ? 'Metal' : 'Forex';
}

function getMaxSpreadPips(pair) {
  return isMetalsPair(pair) ? METALS_MAX_SPREAD_PIPS : MAX_SPREAD_PIPS;
}

function getOandaMaxSpreadPips(instrument, session) {
  const pair = String(instrument).replace('/', '_').toUpperCase();

  if (pair === 'EUR_USD') return 3;
  if (pair === 'GBP_USD') return 4;
  if (pair === 'AUD_USD') return 5;
  if (pair === 'NZD_USD') return 6;
  if (pair === 'USD_CAD') return 6;
  if (pair === 'USD_JPY') return 5;

  if (pair.includes('JPY')) return 12;
  if (pair.includes('GBP')) return 8;

  return 6;
}

/**
 * Calculate USD notional value for display.
 * Mirrors calculateForexNotionalUSD in oandaTrade.js — keep in sync.
 *
 *   USD base (USD_JPY, USD_CAD, USD_CHF): notional = units
 *   USD quote (EUR_USD, GBP_USD, AUD_USD): notional = units × price
 *   Metals (XAU_USD, XAG_USD):            notional = units × price
 *   Cross pairs (EUR_JPY, GBP_JPY, …):    fallback = units
 */
function calculateDisplayNotional(pair, units, entryPrice) {
  if (pair === 'XAU_USD' || pair === 'XAG_USD') {
    return Number((units * entryPrice).toFixed(2));
  }
  const [base, quote] = pair.split('_');
  if (base  === 'USD') return units;
  if (quote === 'USD') return Number((units * entryPrice).toFixed(2));
  return units; // cross pairs
}

/**
 * Trade duration label based on macro volatility regime and session — display only.
 * Macro/structure/momentum layers handle the actual qualification.
 */
function getTradeDuration(session, atrPips, pair) {
  const metals = isMetalsPair(pair);
  const lowAtr = metals ? (!atrPips || atrPips < 30) : (!atrPips || atrPips < 4);
  const goodAtr = metals ? (atrPips >= 50) : (atrPips >= 6);
  const highVolSession = session === 'London/NewYork Overlap' || session === 'London' || session === 'NewYork';
  const lowLiqSession = session === 'Sydney' || session === 'Sydney/Tokyo Overlap';

  if (lowLiqSession || lowAtr) return 'Scalp';
  if (highVolSession && goodAtr) return 'Intraday';
  if (session === 'Tokyo/London Overlap' && goodAtr) return 'Intraday';
  return 'Swing';
}

function getEstimatedHoldMinutes(tradeDuration) {
  if (tradeDuration === 'Scalp') return 20;
  if (tradeDuration === 'Intraday') return 90;
  return 240;
}

function getExpectedMovementPips(atrPips, tradeDuration) {
  if (!atrPips) return null;
  const multiplier = tradeDuration === 'Scalp' ? 0.5 : tradeDuration === 'Intraday' ? 1.5 : 2.5;
  return Math.round(atrPips * multiplier);
}


// ─── 2am–4am ET liquidity sweep focus ─────────────────────────────────────────
function nyMinutesSinceMidnight(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);

  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10) % 24;
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);

  return hour * 60 + minute;
}

function isLiquiditySweepWindow(now = new Date()) {
  const mins = nyMinutesSinceMidnight(now);
  return mins >= 120 && mins < 240;
}

function tradeDirectionFromBias(bias) {
  if (bias === 'bullish') return 'long';
  if (bias === 'bearish') return 'short';
  return null;
}

function getLiquiditySweepSignals(institutionalFlow) {
  const signals = Array.isArray(institutionalFlow?.signals) ? institutionalFlow.signals : [];
  return signals.filter((s) => s?.type === 'liquidity_sweep' || s?.subtype === 'failed_breakout');
}


// ─── Pair ranking ─────────────────────────────────────────────────────────────

function rankPairsByQuality(pairs, pricingMap, session) {
  const sessionBonus = session.includes('Overlap') ? 2 : session === 'London' || session === 'NewYork' ? 1 : 0;

  return [...pairs].sort((a, b) => {
    const pA = pricingMap[a];
    const pB = pricingMap[b];
    if (!pA && !pB) return 0;
    if (!pA) return 1;
    if (!pB) return -1;

    const spreadScoreA = pA.spreadPips <= 1.0 ? 3 : pA.spreadPips <= 1.5 ? 2 : 1;
    const spreadScoreB = pB.spreadPips <= 1.0 ? 3 : pB.spreadPips <= 1.5 ? 2 : 1;

    return (spreadScoreB + sessionBonus) - (spreadScoreA + sessionBonus);
  });
}

// ─── Main scanner ─────────────────────────────────────────────────────────────

/**
 * Run the full multi-asset scan.
 *
 * @param {string[]|null} pairsOverride — explicit pair list (otherwise uses ORDERED_WATCHLIST)
 * @param {Object}        [options]
 * @param {Object}        [options.client] — per-request OANDA client from
 *   `createOandaClient`. When passed, every market-data call inside the scan
 *   uses this user's credentials. When omitted, falls back to the env-based
 *   default client (dev fallback).
 */
export async function scanForexPairs(pairsOverride = null, options = {}) {
  const { client } = options;
  const pairs = prioritizeRetraceWatchPairs(pairsOverride || ORDERED_WATCHLIST);
  const session = getForexSession();

  setScanInProgress(true);
  // ── Signal Stack V3 self-improvement layer ────────────────────────────────
  // Read the calibration snapshot (monthly Expected-RR vs Realized-R + the
  // auto-adjusted rejection threshold) once per scan. The scanner passes the
  // calibrated threshold into computeExpectedRR so qualification standards
  // tighten automatically when the platform's projections overshoot reality.
  const calibration = getCalibrationSnapshot(getTradeHistory(1000));
  console.log(
    `[CALIBRATION] threshold=${calibration.calibratedRejectionThreshold} ` +
    `(default ${calibration.defaultRejectionThreshold}) ` +
    `samples=${calibration.rolling.sampleCount} ` +
    `captureRatio=${calibration.rolling.captureRatio ?? 'n/a'} ` +
    `eligible=${calibration.eligibleForAdjustment}`,
  );
  console.log(`\n[SCANNER] ▶ Scan started — session: ${session}`);
  console.log(`[SCANNER] ${DYNAMIC_RISK_NOTICE}`);
  console.log(`[SCANNER] Reviewing ${pairs.length} instruments: ${pairs.join(', ')}`);

  // ── Fetch pricing for all pairs up-front ──────────────────────────────────
  let pricingMap = {};
  try {
    const prices = await getPricing(pairs, { client });
    for (const p of prices) pricingMap[p.instrument] = p;
  } catch (err) {
    setScanInProgress(false);
    console.error('[SCANNER] Failed to fetch pricing:', err.message);
    throw err;
  }

  // ── Fetch account summary once (used by fixed-dollar sizing per pair) ─────
  let accountSummary = null;
  try {
    accountSummary = await getAccountSummary({ client });
  } catch (err) {
    console.warn(`[SCANNER] Account summary unavailable — falling back to leverage defaults: ${err.message}`);
  }
  const accountBalanceUSD = accountSummary ? parseFloat(accountSummary.balance || 0) : null;
  const accountMarginRate = accountSummary ? parseFloat(accountSummary.marginRate || 0) : 0;

  const rankedPairs = rankPairsByQuality(pairs, pricingMap, session);
  console.log(`[SCANNER] Pair scan order: ${rankedPairs.join(', ')}`);

  const qualified = [];
  const rejected = [];
  // Signal Stack V3 execution engine — per-pair evaluations for shadow/active
  // comparison. Populated only when FOREX_V3_ENGINE_MODE != 'off'.
  const v3ByPair = {};

  for (const pair of rankedPairs) {
    slog('debug', `[SCANNER] Analyzing ${pair} (${getInstrumentName(pair)})...`);

    try {
      const pricing = pricingMap[pair];
      if (!pricing) {
        rejected.push({ pair, reason: 'No pricing data returned from OANDA' });
        continue;
      }
      if (!pricing.tradeable) {
        rejected.push({ pair, reason: 'Instrument not tradeable (market closed or suspended)' });
        continue;
      }

      // ── Per-instrument spread filter ─────────────────────────────────────
      const metals = isMetalsPair(pair);
      const maxSpread = metals
        ? getMaxSpreadPips(pair)                   // metals: keeps METALS_MAX_SPREAD_PIPS unchanged
        : getOandaMaxSpreadPips(pair, session);    // forex: pair-aware dynamic limit
      console.log('[OANDA_DYNAMIC_SPREAD_LIMIT]', {
        instrument: pair,
        session,
        spreadPips: pricing.spreadPips,
        maxSpread,
      });
      console.log(`[OANDA_SPREAD_CHECK] instrument=${pair} bid=${pricing.bid} ask=${pricing.ask} spreadPips=${pricing.spreadPips} max=${maxSpread}`);
      if (pricing.spreadPips > maxSpread) {
        rejected.push({
          pair,
          reason: `Spread too wide: ${pricing.spreadPips.toFixed(1)} pips > ${maxSpread} pips (${pair}, ${session})`,
          spreadPips: pricing.spreadPips,
        });
        slog('debug', `[SCANNER] ✗ ${pair} —spread ${pricing.spreadPips.toFixed(1)} pips (limit: ${maxSpread})`);
        continue;
      }

      // ── LAYER 0: Fetch Daily + H4 + H1 + M30 + M15 + M5 candles ─────────
      const [dailyCandles, h4Candles, h1Candles, m30Candles, m15Candles, m5Candles] = await Promise.all([
        getCandles(pair, 'D',   60,  { client }).catch(() => []),
        getCandles(pair, 'H4',  60,  { client }).catch(() => []),
        getCandles(pair, 'H1',  80,  { client }).catch(() => []),
        getCandles(pair, 'M30', 96,  { client }).catch(() => []),
        getCandles(pair, 'M15', 120, { client }).catch(() => []),
        getCandles(pair, 'M5',  120, { client }).catch(() => []),
      ]);

      if (m15Candles.length < 60) {
        rejected.push({
          pair,
          reason: `Not enough M15 candles: ${m15Candles.length} (need 60+)`,
          rejectionReasons: [`Insufficient M15 history (${m15Candles.length} bars)`],
        });
        continue;
      }

      const pipSize = getPipSize(pair);
      const atrM15  = m15Candles.length >= 15 ? atr(m15Candles, 14) : null;
      const atrPips = atrM15 !== null ? +(atrM15 / pipSize).toFixed(2) : null;

      // ── LAYER 1 — MACRO (Daily + H4) ─────────────────────────────────────
      const macro = analyzeMacro({ dailyCandles, h4Candles, pair });

      // ── LAYER 2 — STRUCTURE (H1 + M30) ──────────────────────────────────
      const structure = analyzeStructure({ h1Candles, m30Candles, macro, pair });

      // ── LAYER 3 — MOMENTUM / EXECUTION (M15 + M5) ───────────────────────
      const momentum = analyzeMomentum({
        m15Candles, m5Candles,
        macroBias: macro.macroBias,
        structure,
        pair,
        spreadPips: pricing.spreadPips,
        maxSpreadPips: maxSpread,
      });

      // ── ALIGNMENT ENGINE — fold all three layers ────────────────────────
      const alignment = computeAlignment({ macro, structure, momentum });

      // ── Pre-trade safety: low-level risk monitor (volatility spikes, etc) ─
      const risk = checkMarketConditions({
        pair,
        candles: m15Candles,
        currentSpreadPips: pricing.spreadPips,
        baselineSpreadPips: getTypicalSpread(pair),
        atrValue: atrM15,
        closes: m15Candles.map(c => c.close),
      });
      if (!risk.safe) alignment.rejectionReasons.push(`Risk monitor: ${risk.reason}`);

      // ── Direction for downstream sizing ─────────────────────────────────
      let direction = momentum.executionSignal;         // null when no signal; may be set by 2am-4am liquidity sweep mode

      // ── Signal Stack V3 execution engine (feature-flagged) ──────────────
      // Evaluate the liquidity/structure/session/volatility model for every
      // data-sufficient pair. In off/shadow this is purely observational and
      // does NOT alter the legacy qualification below. Wrapped so a failure
      // can never break a scan.
      let v3Eval = null;
      if (isV3Enabled()) {
        try {
          v3Eval = evaluateV3({
            pair,
            legacyDirection: direction,
            dailyCandles, h4Candles, h1Candles, m15Candles,
            currentPrice: pricing.mid,
            atrPips,
            atrHistorical: macro.atrPipsHistorical ?? null,
            momentum,
            now: new Date(),
          });
          v3ByPair[pair] = v3Eval;
        } catch (v3Err) {
          // Never break a scan, but surface enough to debug a V3-only failure.
          console.log(`[V3] eval skipped for ${pair}: ${v3Err.message}\n${v3Err.stack || ''}`);
        }
      }

      // ── V3.5 ACTIVE-WINDOW DIRECTION BRIDGE ───────────────────────────────
      // If legacy momentum is too slow to produce a direction, allow V3.5 to
      // supply direction during the active opportunity window. This does NOT
      // bypass hard execution gates; it only lets the setup reach the normal
      // entry-quality, lifecycle, RR, sizing, margin, and execution layers.
      if (
        String(process.env.FOREX_ACTIVE_WINDOW_V3_BRIDGE || 'true').toLowerCase() === 'true' &&
        isActiveOpportunityWindow(new Date()) &&
        !direction &&
        v3Eval?.direction &&
        Number(v3Eval?.score ?? 0) >= Number(process.env.FOREX_ACTIVE_WINDOW_V3_MIN_SCORE || 55) &&
        (
          v3Eval?.qualified === true ||
          v3Eval?.earlyTrigger === true ||
          Number(v3Eval?.premiumDiscount?.premiumDiscountScore ?? 0) >= 0.65 ||
          Number(v3Eval?.liquidityIntent?.intentScore ?? v3Eval?.liquidityIntent?.score ?? 0) >= 0.6
        )
      ) {
        direction = v3Eval.direction;
        console.log(
          `[ACTIVE_WINDOW_V3_BRIDGE] ${pair} direction=${direction} ` +
          `v3Score=${v3Eval.score} early=${v3Eval.earlyTrigger === true} ` +
          `pd=${v3Eval?.premiumDiscount?.premiumDiscountState ?? 'n/a'}`
        );
      }

      // ── ENTRY-QUALITY LAYER ─────────────────────────────────────────────
      // Fibonacci retracement + institutional-flow proxies + news-risk +
      // composite entry-timing classifier. These attach to every signal
      // (qualified AND rejected) for full dashboard visibility.
      //
      // Hybrid gate (default): hard-block on news.blocked OR opposing flow.
      // Soft (warn-only): fib `too_early` is informational unless
      // FOREX_ENTRY_TIMING_STRICT=true.
      const fibonacci = detectFibSetup({
        direction, h1Candles, h4Candles, currentPrice: pricing.mid, pair,
      });
      const institutionalFlow = analyzeInstitutionalFlow({
        pair,
        tradeDirection: direction,
        m15Candles, h1Candles, h4Candles,
        priorTrend: macro.h4Trend,
        structureType: macro.marketStructure?.type,
      });
      const newsRisk = await getForexNewsRisk(pair).catch(err => {
        console.warn(`[ENTRY_TIMING] ${pair} — newsRisk failed: ${err.message}; treating as low`);
        return { pair, enabled: true, blocked: false, riskLevel: 'low',
                 matchingCurrencies: [], upcomingEvents: [], recentEvents: [],
                 postNewsConfirmationRequired: false, reason: 'news provider error',
                 provider: { source: null, warning: err.message } };
      });
      const liquiditySweepWindowActive = isLiquiditySweepWindow();
      const liquiditySweepSignals = getLiquiditySweepSignals(institutionalFlow);
      const liquiditySweepDetected = liquiditySweepSignals.length > 0;
      const sweepBias =
        institutionalFlow?.direction === 'bullish' || institutionalFlow?.direction === 'bearish'
          ? institutionalFlow.direction
          : null;

      const dailyH4Aligned =
        macro.dailyTrend === macro.h4Trend &&
        (macro.dailyTrend === 'bullish' || macro.dailyTrend === 'bearish');

      const m15OpposesSweep =
        sweepBias === 'bullish'
          ? momentum.m15Trend === 'bearish'
          : sweepBias === 'bearish'
            ? momentum.m15Trend === 'bullish'
            : false;

      let liquiditySweepWindowOverride = false;

      if (
        liquiditySweepWindowActive &&
        liquiditySweepDetected &&
        dailyH4Aligned &&
        sweepBias === macro.dailyTrend &&
        !m15OpposesSweep
      ) {
        const sweepDirection = tradeDirectionFromBias(sweepBias);
        if (!direction && sweepDirection) direction = sweepDirection;

        alignment.rejectionReasons = (alignment.rejectionReasons || []).filter((reason) => {
          const s = String(reason || '').toLowerCase();
          return !(
            s.includes('active-window warning: weak momentum signal, scalp/swing fallback allowed') ||
            s.includes('timeframes conflict with macro') ||
            s.includes('h1') ||
            s.includes('m30') ||
            s.includes('m5')
          );
        });

        if (!Array.isArray(alignment.warnings)) alignment.warnings = [];
        alignment.warnings.push(
          '2am-4am liquidity sweep mode: valid sweep aligned with Daily/H4 bias; lower-timeframe conflict treated as context only.'
        );

        alignment.tradeQualified = alignment.rejectionReasons.length === 0;
        liquiditySweepWindowOverride = true;
      }

      console.log(
        `[LIQUIDITY_SWEEP_WINDOW] pair=${pair} active=${liquiditySweepWindowActive} ` +
        `sweep=${liquiditySweepDetected} bias=${sweepBias ?? 'none'} ` +
        `dailyH4Aligned=${dailyH4Aligned} m15Opposes=${m15OpposesSweep} ` +
        `action=${liquiditySweepWindowOverride ? 'sweep_priority' : 'none'}`
      );

      const entryTiming = classifyEntryTiming({
        direction, fibonacci, institutionalFlow, structure, momentum, newsRisk,
        currentPrice: pricing.mid, pair,
      });

      // ── EXTENDED QUALIFICATION LAYER (2026-05-27 upgrade) ───────────────
      // Modules added to reduce SL hit rate caused by late entries, weak
      // candles, wrong market state, HTF conflicts, and bad instrument
      // tuning. See server/oanda{CandleStrength,MarketState,MtfAuthority,
      // Overextension,InstrumentProfiles}.js.
      const profile = getInstrumentProfile(pair);
      const candleStrength = analyzeRecentCandleStrength({
        candles: m15Candles, direction, pair, atrPips: momentum.atrPips, window: 3,
      });
      const marketState = classifyMarketState({
        macro, structure, momentum,
        candlesM15: m15Candles, candlesH1: h1Candles, session,
      });
      const mtfAuthority = direction
        ? assessMtfAuthority({
            direction,
            h4Candles, h1Candles, m15Candles,
            macro, structure,
          })
        : null;
      const overextension = direction
        ? classifyOverextension({
            candles: m15Candles, direction,
            atrPips: momentum.atrPips, pair,
            structure,
            srProximity: momentum.srProximity,
          })
        : null;

      console.log(
        `[QUAL] ${pair} ${direction ?? '—'} — state=${marketState.marketState}(${marketState.marketStateScore}) ` +
        `candle=${candleStrength.classification}(${candleStrength.candleStrengthScore}) ` +
        `mtf=${mtfAuthority?.multiTimeframeAlignmentScore ?? '—'}/100${mtfAuthority?.conflict ? '/CONFLICT' : ''} ` +
        `overext=${overextension?.overextensionScore ?? '—'}${overextension?.lateEntryDetected ? '/LATE' : ''} ` +
        `profile=${profile.assetClass}`
      );

      // Hard-block additions (Task 2/3/6/7): market-state ban, MTF conflict,
      // late entry without pullback, profile-allowed states.
      if (marketState.rules.rejectContinuation && direction) {
        // continuation trades are rejected in REVERSAL_RISK / CHOPPY / RANGING etc.
        // Pullback or reversal setups may still be allowed by the entryTiming layer.
        const isReversal = mtfAuthority?.isReversalSetup === true;
        const isPullback = overextension?.isPullbackEntry === true;
        if (!isReversal && !isPullback) {
          alignment.rejectionReasons.push(
            `Rejected: market state is ${marketState.marketState.toLowerCase()} — ${marketState.marketStateReason}`
          );
        }
      }
      if (mtfAuthority?.conflict) {
        if (!Array.isArray(alignment.warnings)) alignment.warnings = [];
        alignment.warnings.push(
          `Context only: HTF authority note — ${mtfAuthority.higherTimeframeBias} trend conflicts with ${direction ?? 'pending'} entry. ${mtfAuthority.multiTimeframeReason}`
        );
      }
      if (overextension?.lateEntryDetected) {
        if (!isActiveOpportunityWindow(new Date())) {
          alignment.rejectionReasons.push(`Rejected: late entry after extended move. ${overextension.entryTimingReason}`);
        } else {
          if (!Array.isArray(alignment.warnings)) alignment.warnings = [];
          alignment.warnings.push(`Active-window warning: late entry/overextension softened. ${overextension.entryTimingReason}`);
        }
      }
      if (candleStrength.classification === 'rejection') {
        alignment.rejectionReasons.push(
          `Rejected: candle has strong ${direction === 'long' ? 'upper' : 'lower'} wick rejection. ${candleStrength.reason}`
        );
      }
      if (candleStrength.candleStrengthScore < profile.minCandleStrength) {
        alignment.rejectionReasons.push(
          `Rejected: candle strength ${candleStrength.candleStrengthScore} < profile floor ${profile.minCandleStrength}. ${candleStrength.reason}`
        );
      }
      if (!profile.allowedMarketStates.includes(marketState.marketState)) {
        alignment.rejectionReasons.push(
          `Rejected: ${profile.assetClass} profile does not allow ${marketState.marketState} state ` +
          `(allowed: ${profile.allowedMarketStates.join(', ')})`
        );
      }
      // Per-instrument spread floor
      if (Number.isFinite(profile.maxSpreadPips) && pricing.spreadPips > profile.maxSpreadPips) {
        alignment.rejectionReasons.push(
          `Rejected: spread ${pricing.spreadPips}p exceeds ${profile.assetClass} profile cap ${profile.maxSpreadPips}p`
        );
      }

      console.log(
        `[ENTRY_TIMING] ${pair} ${direction ?? '—'} — fib=${fibonacci.entryZoneStatus ?? 'unknown'}` +
        `(${fibonacci.timeframeUsed || '—'},retraced=${fibonacci.pctRetraced ?? '—'}) ` +
        `flow=${institutionalFlow.direction}/${institutionalFlow.type}(impact=${institutionalFlow.confidenceImpact}) ` +
        `news=${newsRisk.riskLevel}${newsRisk.blocked ? '/BLOCKED' : ''} ` +
        `→ status=${entryTiming.status}`
      );

      // Hybrid hard-blocks: news + opposing institutional flow.
      // These attach as rejection reasons BEFORE the existing alignment check
      // so the dashboard shows the proper category.
      if (newsRisk.blocked) {
        alignment.rejectionReasons.push(`News block: ${newsRisk.reason}`);
      }
      const tradeSign = direction === 'long' ? 'bullish' : direction === 'short' ? 'bearish' : null;
      if (
        tradeSign && institutionalFlow.detected &&
        institutionalFlow.direction !== 'neutral' &&
        institutionalFlow.direction !== tradeSign
      ) {
        alignment.rejectionReasons.push(
          `Institutional flow proxy points ${institutionalFlow.direction} ` +
          `(top: ${institutionalFlow.type}) — opposes ${direction} trade`
        );
      }
      // Strict mode: also reject on fib too_early
      if (ENTRY_TIMING_STRICT && entryTiming.status === 'too_early') {
        alignment.rejectionReasons.push(
          `Strict mode: ${entryTiming.reason}`
        );
      }

      // ── Per-pair debug log (rich) ───────────────────────────────────────
      // One line per pair covering: candle counts, latest candle times, trend
      // per timeframe, the three layer confidences, the alignment score, and
      // the rejection reasons. Designed to be greppable in the backend logs.
      if (scannerLogEnabled('debug')) {
        const lastTs = (arr) => arr.length ? new Date(arr[arr.length - 1].time * 1000 || arr[arr.length - 1].time).toISOString() : '—';
        console.log(`[DEBUG] ${pair}`);
        console.log(`  candles  D=${dailyCandles.length} H4=${h4Candles.length} H1=${h1Candles.length} M30=${m30Candles.length} M15=${m15Candles.length} M5=${m5Candles.length}`);
        console.log(`  latest   D=${lastTs(dailyCandles)} H4=${lastTs(h4Candles)} H1=${lastTs(h1Candles)} M30=${lastTs(m30Candles)} M15=${lastTs(m15Candles)} M5=${lastTs(m5Candles)}`);
        console.log(`  trends   D=${macro.dailyTrend} H4=${macro.h4Trend} H1=${structure.h1Trend} M30=${structure.m30Trend} M15=${momentum.m15Trend} M5=${momentum.m5Trend}`);
        console.log(`  conf     macro=${macro.macroConfidence} struct=${structure.structuralConfidence} exec=${momentum.executionConfidence} (m15Confirm=${momentum.executionConfirmation})`);
        console.log(`  align    score=${alignment.timeframeAlignmentScore} status=${alignment.alignmentStatus} conflicts=[${alignment.conflictingTimeframes.join(',')}]`);
        console.log(
          `[WATERFALL] ${pair} — macro=${macro.macroBias}(${macro.macroConfidence}) ` +
          `struct=${structure.structureAligned ? 'aligned' : 'misaligned'}(${structure.structuralConfidence}, rev=${structure.reversalRisk}) ` +
          `momentum=${direction ?? '—'}(${momentum.executionConfidence}) ` +
          `align=${alignment.timeframeAlignmentScore}/${alignment.alignmentStatus} ` +
          `conflicts=[${alignment.conflictingTimeframes.join(',')}]`
        );
      }

      // ── Categorize the rejection so the dashboard can distinguish each
      //    failure mode. Extended 2026-05-27 with market_state, htf_conflict,
      //    late_entry, candle_rejection, profile_block, spread_block.
      const categorizeRejection = () => {
        const reasons = alignment.rejectionReasons;
        const has = (re) => reasons.some(r => re.test(r));
        if (has(/^News block:|high-impact .* news/i)) return 'news_blocked';
        if (has(/Institutional flow proxy points/i)) return 'flow_opposes';
        if (has(/HTF .* trend conflicts/i))          return 'htf_conflict';
        if (has(/late entry after extended move/i))  return isActiveOpportunityWindow(new Date()) ? 'active_window_warning' : 'late_entry';
        if (has(/wick rejection|candle strength/i))  return 'candle_rejection';
        if (has(/market state is/i))                 return 'market_state';
        if (has(/profile does not allow|profile cap|profile floor/i)) return 'profile_block';
        if (has(/^Rejected: spread |Spread too high/i)) return 'spread_block';
        if (has(/Risk monitor:/i))                   return 'risk_filter';
        if (has(/conflict|reversal risk is HIGH/i))  return 'conflicting_setup';
        if (has(/Macro bias is ranging|no execution signal|opposes macro/i)) return 'no_setup';
        return 'weak_setup';
      };

      // ── REJECT if alignment engine says no (or hybrid gate fired) ───────
      const activeWindowBridge = shouldUseActiveWindowV3Bridge({
        v3Eval,
        direction,
        newsRisk,
        pricing,
        maxSpread,
        alignment,
      });

      if (activeWindowBridge.allowed && Array.isArray(alignment.rejectionReasons)) {
        const beforeReasons = alignment.rejectionReasons.length;
        alignment.rejectionReasons = softenActiveWindowRejects(alignment.rejectionReasons, new Date());

        if (alignment.rejectionReasons.length < beforeReasons) {
          if (!Array.isArray(alignment.warnings)) alignment.warnings = [];
          alignment.warnings.push(
            `Active-window V3.5 bridge softened legacy blockers: ${activeWindowBridge.reason}`
          );

          console.log(
            `[ACTIVE_WINDOW_V3_BRIDGE] ${pair} softened ` +
            `${beforeReasons - alignment.rejectionReasons.length}/${beforeReasons} legacy blocker(s): ${activeWindowBridge.reason}`
          );
        }

        if (alignment.rejectionReasons.length === 0) {
          alignment.tradeQualified = true;
        }
      }

      const hardBlockedByEntryQuality =
        newsRisk.blocked ||
        (tradeSign && institutionalFlow.detected &&
          institutionalFlow.direction !== 'neutral' &&
          institutionalFlow.direction !== tradeSign) ||
        (ENTRY_TIMING_STRICT && entryTiming.status === 'too_early');

      if (!alignment.tradeQualified || !direction || hardBlockedByEntryQuality) {
        const rejectionCategory = categorizeRejection();
        rejected.push({
          pair,
          direction: direction ?? null,
          reason: alignment.rejectionReasons[0] || 'Trade rejected by waterfall',
          rejectionReasons: alignment.rejectionReasons,
          rejectionCategory,
          macro, structure, momentum, alignment,
          fibonacci, institutionalFlow, newsRisk, entryTiming,
          candleStrength, marketState, mtfAuthority, overextension, profile,
          spreadPips: pricing.spreadPips, session,
        });
        slog('debug', `[SCANNER] ✗ ${pair} —[${rejectionCategory}] ${alignment.rejectionReasons.length} reason(s)`);
        continue;
      }

      // ── Multi-factor confidence (no single indicator dominates) ─────────
      // newsRisk.riskLevel now feeds the confidence aggregator (previously
      // hard-coded to 'none'). institutionalFlow.confidenceImpact is then
      // applied on top to nudge confidence ± based on order-flow alignment.
      const baseConfidence = computeConfidenceScore({
        macro, structure, momentum, alignment,
        spreadPips: pricing.spreadPips,
        maxSpreadPips: maxSpread,
        session,
        newsRisk: newsRisk.riskLevel,
      });
      const confidence = Math.max(0, Math.min(100,
        baseConfidence + (institutionalFlow.confidenceImpact || 0)
      ));

      if (confidence < MIN_CONFIDENCE) {
        alignment.rejectionReasons.push(`Aggregate confidence ${confidence}% < min ${MIN_CONFIDENCE}%`);
        rejected.push({
          pair,
          direction,
          confidence,
          reason: `Aggregate confidence ${confidence}% < min ${MIN_CONFIDENCE}%`,
          rejectionReasons: alignment.rejectionReasons,
          rejectionCategory: 'weak_setup',
          macro, structure, momentum, alignment,
          fibonacci, institutionalFlow, newsRisk, entryTiming,
          candleStrength, marketState, mtfAuthority, overextension, profile,
          spreadPips: pricing.spreadPips, session,
        });
        slog('debug', `[SCANNER] ✗ ${pair} —[weak_setup] aggregate confidence ${confidence}% below threshold`);
        continue;
      }

      // ── Display-only volatility state from macro layer ──────────────────
      const volatilityState =
        macro.volatilityRegime === 'expanded'   ? 'expanding' :
        macro.volatilityRegime === 'compressed' ? 'low'       : 'normal';

      // ── Dynamic SL / TP / hold-window (trade lifecycle engine) ──────────
      const entry = pricing.mid;

      const lifecycle = computeTradeLifecycle({
        pair, direction, entryPrice: entry,
        atrPips: momentum.atrPips,
        m15Candles, h1Candles,
        spreadPips: pricing.spreadPips,
        maxSpreadPips: maxSpread,
        session,
        macro, structure, momentum, alignment,
        fibonacci, institutionalFlow,
        marketState, profile, candleStrength,   // NEW — state-aware TP/SL
      });

      if (!lifecycle.allowed) {
        const category = lifecycle.rejectionReason.startsWith('Required SL')
          ? 'risk_filter'
          : lifecycle.rejectionReason.includes('R:R')
          ? 'weak_setup'
          : 'risk_filter';
        rejected.push({
          pair, direction, confidence,
          reason: lifecycle.rejectionReason,
          rejectionReasons: [...alignment.rejectionReasons, lifecycle.rejectionReason],
          rejectionCategory: category,
          macro, structure, momentum, alignment,
          fibonacci, institutionalFlow, newsRisk, entryTiming,
          candleStrength, marketState, mtfAuthority, overextension, profile,
          spreadPips: pricing.spreadPips, session,
          lifecycle,
        });
        slog('debug', `[SCANNER] ✗ ${pair} —[${category}] lifecycle reject: ${lifecycle.rejectionReason}`);
        continue;
      }

      // ── ASSET-CLASS ROUTER ─────────────────────────────────────────────
      // Lifecycle has produced a viable SL/TP. Now run the asset-class
      // specific qualifier (metals / indices / forex pass-through). This is
      // where the dashboard's `selectedLogicType` is determined and where
      // the asset-specific rejection reasons originate.
      const assetClassQualifier = qualifyByAssetClass({
        pair, direction,
        m15Candles, h1Candles, h4Candles,
        currentPrice: entry,
        candleStrength, marketState, mtfAuthority, overextension,
        institutionalFlow, fibonacci, entryTiming, newsRisk,
        pricing, lifecycle, session, profile,
      });
      if (!assetClassQualifier.accepted) {
        const acRejections = assetClassQualifier.rejectionReasons || [];
        const allReasons = [...alignment.rejectionReasons, ...acRejections];
        const acCategory = profile.assetClass === 'Metal'
          ? 'metals_logic_reject'
          : profile.assetClass === 'Index'
            ? 'indices_logic_reject'
            : 'asset_class_reject';
        rejected.push({
          pair, direction, confidence,
          reason: acRejections[0] || 'Rejected by asset-class logic',
          rejectionReasons: allReasons,
          rejectionCategory: acCategory,
          macro, structure, momentum, alignment,
          fibonacci, institutionalFlow, newsRisk, entryTiming,
          candleStrength, marketState, mtfAuthority, overextension, profile,
          spreadPips: pricing.spreadPips, session,
          lifecycle,
          selectedLogicType: assetClassQualifier.selectedLogicType,
          assetClass: assetClassQualifier.assetClass,
          assetClassRejectionReasons: acRejections,
          metalsSetupScore: assetClassQualifier.classSpecific?.metalsSetupScore,
          indexSetupScore: assetClassQualifier.classSpecific?.indexSetupScore,
          finalQualifiedStatus: 'rejected_asset_class',
        });
        console.log(
          `[SCANNER] ✗ ${pair} — [${acCategory}] ${assetClassQualifier.selectedLogicType} ` +
          `qualifier rejected (${acRejections.length} reason${acRejections.length === 1 ? '' : 's'})`
        );
        continue;
      }

      // ── Signal Stack V3 — Expected-R qualification ─────────────────────
      // Folds lifecycle SL/TP geometry with quality factors (confidence,
      // alignment, trend, market state, flow, volatility, candle strength)
      // into a realistic `expectedRR`. Tiers: standard / preferred / premium;
      // tier === 'reject' (expectedRR < 1.75) rejects the signal here.
      const rrQual = computeExpectedRR({
        stopLossPips:   lifecycle.sl.stopLossPips,
        takeProfitPips: lifecycle.tp.takeProfitPips,
        confidence,
        alignmentScore: alignment.timeframeAlignmentScore,
        trendStrength:  macro.trendStrength,
        volatilityRegime: macro.volatilityRegime,
        marketState:    marketState.marketState,
        allowedMarketStates: profile.allowedMarketStates,
        institutionalFlow,
        direction,
        candleStrengthScore: candleStrength.candleStrengthScore,
        rejectionThreshold: calibration.calibratedRejectionThreshold,
      });
      console.log(
        `[EXPECTED_RR] ${pair} ${direction.toUpperCase()} — ` +
        `geomRR=${rrQual.factors.geometricRR} quality=${rrQual.qualityFactor} ` +
        `expectedRR=${rrQual.expectedRR} tier=${rrQual.rrTier}`
      );
      if (!rrQual.accepted) {
        rejected.push({
          pair, direction, confidence,
          reason: rrQual.rejectionReason,
          rejectionReasons: [...alignment.rejectionReasons, rrQual.rejectionReason],
          rejectionCategory: 'low_expected_rr',
          macro, structure, momentum, alignment,
          fibonacci, institutionalFlow, newsRisk, entryTiming,
          candleStrength, marketState, mtfAuthority, overextension, profile,
          spreadPips: pricing.spreadPips, session,
          lifecycle,
          expectedRiskPips: rrQual.expectedRiskPips,
          expectedRewardPips: rrQual.expectedRewardPips,
          expectedRR: rrQual.expectedRR,
          rrTier: rrQual.rrTier,
          finalQualifiedStatus: 'rejected_expected_rr',
        });
        slog('debug', `[SCANNER] ✗ ${pair} —[low_expected_rr] ${rrQual.rejectionReason}`);
        continue;
      }

      // ── Position sizing using lifecycle SL/TP ───────────────────────────
      const dynamicRisk = computeDynamicTradeRisk({
        accountBalanceUSD,
        confidence,
        score: alignment.timeframeAlignmentScore,    // 0–100 primary timeframe score
        liquiditySweepDetected: (institutionalFlow?.signals || []).some(
          s => s.type === 'liquidity_sweep' || s.subtype === 'failed_breakout'
        ),
        minConfidence: MIN_CONFIDENCE,
        spreadPips: pricing.spreadPips,
        maxSpreadPips: maxSpread,
        volatilityState,
      });

      if (!dynamicRisk.allowed) {
        const reason = dynamicRisk.reason === 'no_balance'
          ? 'Account balance unavailable — cannot size trade dynamically'
          : `Dynamic risk sizing rejected: ${dynamicRisk.reason}`;
        alignment.rejectionReasons.push(reason);
        rejected.push({
          pair, direction, confidence, reason,
          rejectionReasons: alignment.rejectionReasons,
          rejectionCategory: 'risk_filter',
          macro, structure, momentum, alignment,
          fibonacci, institutionalFlow, newsRisk, entryTiming,
          candleStrength, marketState, mtfAuthority, overextension, profile,
          spreadPips: pricing.spreadPips, session,
        });
        slog('debug', `[SCANNER] ✗ ${pair} —${reason}`);
        continue;
      }

      const sizing = computeFixedDollarSizing({
        pair,
        direction,
        entryPrice: entry,
        targetRiskUSD: dynamicRisk.riskUSD,
        stopLossPips:   lifecycle.sl.stopLossPips,
        stopLossPrice:  lifecycle.sl.stopLossPrice,
        takeProfitPips: lifecycle.tp.takeProfitPips,
        takeProfitPrice:lifecycle.tp.takeProfitPrice,
        accountMarginRate,
        accountBalanceUSD,
      });

      const stopLossPips   = sizing.stopLossPips;
      const takeProfitPips = sizing.takeProfitPips;
      const stopLoss       = sizing.stopLoss;
      const takeProfit     = sizing.takeProfit;
      const riskReward     = +sizing.riskReward.toFixed(2);
      const tradeUnits     = sizing.tradeUnits;
      const lotSize        = sizing.lotSize;

      const amountTraded   = calculateDisplayNotional(pair, tradeUnits, entry);
      const sizingWarnings = [...sizing.warnings];

      // ── Per-pair lifecycle debug log ────────────────────────────────────
      console.log(`[LIFECYCLE] ${pair} ${direction.toUpperCase()}`);
      console.log(`  SL    pips=${stopLossPips} price=${stopLoss} reason="${lifecycle.sl.invalidationReason}" buffer=${lifecycle.sl.volatilityBufferPips}p atrMult=${lifecycle.sl.atrMultiple}`);
      console.log(`  TP    pips=${takeProfitPips} price=${takeProfit} R:R=1:${riskReward} reason="${lifecycle.tp.targetReason}"`);
      console.log(`  caps  cappedByKeyLevel=${lifecycle.tp.cappedByKeyLevel} keyLevelDistance=${lifecycle.tp.keyLevelDistance}p cappedByAtr=${lifecycle.tp.cappedByAtr}`);
      console.log(`  hold  ${lifecycle.hold.minMinutes}-${lifecycle.hold.maxMinutes}m (conf ${lifecycle.hold.holdConfidence}) velocity=${lifecycle.hold.pipsPerMinute}p/min reason="${lifecycle.hold.timeToTPReason}"`);
      slog('debug', `  prob  TP=${lifecycle.probs.tpProbability} SL=${lifecycle.probs.slProbability} | session=${session} vol=${macro.volatilityRegime} atrPips=${momentum.atrPips}`);

      const modifierTag = dynamicRisk.factors.modifiers.length
        ? ` [${dynamicRisk.factors.modifiers.join(', ')}]`
        : '';
      console.log(
        `[RISK_SIZING] ${pair} ${direction.toUpperCase()} — risk ${dynamicRisk.riskPercent}% ($${sizing.actualRiskUSD}) / reward $${sizing.estimatedRewardUSD} ` +
        `| SL ${stopLossPips}p TP ${takeProfitPips}p (1:${riskReward}) ` +
        `| ${tradeUnits} units (${lotSize} lots) | est. margin $${sizing.estimatedMarginRequired} @ ${sizing.effectiveLeverage}:1${modifierTag}`
      );

      const instrumentName = getInstrumentName(pair);
      const assetClass = getAssetClass(pair);
      const tradeDuration = getTradeDuration(session, atrPips, pair);
      const estimatedHoldMinutes = getEstimatedHoldMinutes(tradeDuration);
      const expectedMovementPips = getExpectedMovementPips(atrPips, tradeDuration);

      // ── Signal Stack V3 — additive intelligence (read-only) ──────────────────
      // These layers annotate the signal for the dashboard/analytics only. They
      // are wrapped so a failure can never break a scan or alter qualification.
      let macroAnalysis = null;
      let marketRegime = null;
      try {
        const [macroRisk, macroBias] = await Promise.all([
          analyzeMacroRisk(pair),
          analyzeMacroBias(pair),
        ]);
        macroAnalysis = {
          risk: macroRisk.macroRisk,
          bias: macroBias.macroBias,
          strength: macroBias.strength,
          reasons: macroBias.reasons,
          upcomingEvents: macroRisk.upcomingEvents,
          hoursUntilNextEvent: macroRisk.hoursUntilNextEvent,
          recommendation: macroRisk.recommendation,
        };
      } catch (macroErr) {
        slog('debug', `[SCANNER] macro layer skipped for ${pair}: ${macroErr.message}`);
      }
      try {
        marketRegime = detectMarketRegime({
          pair,
          indicators: {
            atrPips,
            rsi: momentum.rsi,
            emaAlignment: momentum.m15Alignment,
            trend: momentum.m15Trend,
            trendStrength: macro.trendStrength,
            volatilityRegime: macro.volatilityRegime,
            structureType: macro?.marketStructure?.type,
            marketState: marketState.marketState,
          },
        });
      } catch (regimeErr) {
        slog('debug', `[SCANNER] regime layer skipped for ${pair}: ${regimeErr.message}`);
      }

      // ── V3 'active' mode — conservative gate ────────────────────────────
      // When explicitly switched to 'active', V3 acts as an ADDITIONAL filter
      // on legacy-qualified setups: a legacy signal that V3 deems a late /
      // low-opportunity entry is rejected. It NEVER promotes a setup the legacy
      // model rejected (full V3-native entry generation is gated behind shadow
      // validation). off/shadow do nothing here.
      if (V3_MODE === 'active' && v3Eval && !v3Eval.qualified) {
        rejected.push({
          pair,
          reason: `V3 gate: ${v3Eval.rejectionReasons?.[0] || 'V3 did not qualify (late/low-opportunity entry)'}`,
          rejectionReasons: v3Eval.rejectionReasons,
          v3: v3Eval,
        });
        slog('debug', `[SCANNER] ✗ ${pair} —[v3_gate] ${v3Eval.rejectionReasons?.[0] || 'V3 rejected'}`);
        continue;
      }

      qualified.push({
        pair,
        instrumentName,
        assetClass,
        direction,
        // Signal Stack V3 execution engine evaluation (shadow/active).
        v3: v3Eval,
        score: alignment.timeframeAlignmentScore,    // 0–100 primary timeframe score
        liquiditySweepDetected: (institutionalFlow?.signals || []).some(
          s => s.type === 'liquidity_sweep' || s.subtype === 'failed_breakout'
        ),
        failedBreakoutDetected: (institutionalFlow?.signals || []).some(
          s => s.subtype === 'failed_breakout'
        ),
        liquidityReason: (institutionalFlow?.signals || [])
          .filter(s => s.type === 'liquidity_sweep' || s.subtype === 'failed_breakout')
          .map(s => s.reason).join(' · ') || null,
        // Asset-class router output (2026-05-27 paper-trading + metals/indices upgrade)
        assetClass: profile.assetClass,
        selectedLogicType: assetClassQualifier.selectedLogicType,
        assetClassScore: assetClassQualifier.score,
        assetClassReasons: [
          ...(assetClassQualifier.classSpecific?.metalsVolatilityReason ? [assetClassQualifier.classSpecific.metalsVolatilityReason] : []),
          ...(assetClassQualifier.classSpecific?.metalsSessionReason    ? [assetClassQualifier.classSpecific.metalsSessionReason] : []),
          ...(assetClassQualifier.classSpecific?.metalsLiquidityReason  ? [assetClassQualifier.classSpecific.metalsLiquidityReason] : []),
          ...(assetClassQualifier.classSpecific?.indexSessionReason     ? [assetClassQualifier.classSpecific.indexSessionReason] : []),
          ...(assetClassQualifier.classSpecific?.indexStructureReason   ? [assetClassQualifier.classSpecific.indexStructureReason] : []),
          ...(assetClassQualifier.classSpecific?.indexVolatilityReason  ? [assetClassQualifier.classSpecific.indexVolatilityReason] : []),
        ],
        assetClassRejectionReasons: assetClassQualifier.rejectionReasons,
        metalsSetupScore: assetClassQualifier.classSpecific?.metalsSetupScore,
        indexSetupScore:  assetClassQualifier.classSpecific?.indexSetupScore,
        finalQualifiedStatus: 'qualified',
        // Display / classification
        timeframeEstimate: tradeDuration,
        tradeDuration,
        estimatedHoldMinutes,
        volatilityState,
        atrPips,
        rsi: momentum.rsi,
        macd: momentum.macd,
        // Display-only mirrors from the waterfall — keep flat for the existing
        // intraday cells. These never drive qualification.
        trendStrength: macro.trendStrength,
        momentumScore: momentum.momentumStrength,
        expectedMovementPips,
        directionalConflict: false,
        trend: momentum.m15Trend,
        emaAlignment: momentum.m15Alignment,
        candleConfirmation: momentum.candleConfirmation,
        srProximity: momentum.srProximity,
        mtfAlignment: {
          h1Trend: structure.h1Trend,
          h4Trend: macro.h4Trend,
          allAligned: alignment.alignmentStatus === 'strong',
          htfAligned: structure.structureAligned,
          conflicting: alignment.alignmentStatus === 'conflicting',
          m5EntryAligned:
            (direction === 'long'  && momentum.m5Alignment === 'aligned_bullish') ||
            (direction === 'short' && momentum.m5Alignment === 'aligned_bearish'),
        },
        marketStructure: {
          type: macro.marketStructure.type,
          hasHigherHighs: macro.marketStructure.hasHigherHighs,
          hasHigherLows:  macro.marketStructure.hasHigherLows,
          hasLowerHighs:  macro.marketStructure.hasLowerHighs,
          hasLowerLows:   macro.marketStructure.hasLowerLows,
          hasBreakOfStructure: macro.marketStructure.hasBOS,
          hasRejectionWick: false,
          isConsolidating: macro.marketStructure.type === 'consolidation',
          score: macro.marketStructure.type.startsWith('trending_') ? 2 : 0,
        },
        scoreBreakdown: {
          trend:              macro.dailyTrend !== 'neutral' ? 2 : 0,
          emaAlignment:       momentum.m15Alignment !== 'mixed' ? 2 : 0,
          rsi:                momentum.rsi  != null ? 1 : 0,
          macd:               momentum.macd != null ? 1 : 0,
          atr:                momentum.atrPips >= 6 ? 2 : 1,
          spread:             (pricing.spreadPips / maxSpread) <= 0.3 ? 2 : 1,
          session:            session.includes('Overlap') || session === 'London' || session === 'NewYork' ? 2 : 0,
          mtfAlignment:       structure.structureAligned ? 2 : 0,
          srProximity:        momentum.srProximity ? 1 : 0,
          candleConfirmation: momentum.candleConfirmation === 'bullish' || momentum.candleConfirmation === 'bearish' ? 2 : 0,
        },
        historicalWinRate: null,
        // Signal Stack V3 — additive intelligence layers (informational only)
        macroAnalysis,
        marketRegime,
        generatedAt: new Date().toISOString(),
      });
      console.log(`[SCANNER] ✓ ${pair} ${direction.toUpperCase()} — QUALIFIED (alignment ${alignment.timeframeAlignmentScore}/100, conf ${confidence}%)`);

    } catch (err) {
      console.error(`[SCANNER] Error analyzing ${pair}:`, err.message);
      rejected.push({ pair, reason: `Analysis error: ${err.message}` });
    }
  }

  console.log(`\n[SCANNER] ▶ Scan complete — ${qualified.length} qualified, ${rejected.length} rejected\n`);

  // ── Signal Stack V3 shadow comparison ─────────────────────────────────────
  // Record the legacy-vs-V3 divergence for every evaluated pair (off does
  // nothing). This is observational; it does not alter `qualified`/`rejected`.
  let v3Report = null;
  if (V3_MODE !== 'off') {
    // Backfill V3 analysis onto REJECTED signals so the dashboard can surface
    // V3.5 shadow intelligence even when 0 pairs qualify. Purely additive and
    // diagnostic — keyed by pair from the already-computed v3ByPair, it never
    // changes a rejection decision and never promotes a rejected trade.
    for (const r of rejected) {
      if (r && r.v3 == null && v3ByPair[r.pair]) r.v3 = v3ByPair[r.pair];
    }
    try {
      recordV3Shadow({
        qualified, rejected, v3ByPair, session, nowIso: new Date().toISOString(),
      });
      v3Report = generateV3ComparisonReport();
    } catch (v3Err) {
      console.log(`[V3_SHADOW] recording skipped: ${v3Err.message}`);
    }
  }

  const result = {
    qualified,
    rejected,
    meta: {
      scannedAt: new Date().toISOString(),
      session,
      pairsScanned: pairs.length,
      totalQualified: qualified.length,
      totalRejected: rejected.length,
      minConfidence: MIN_CONFIDENCE,
      minAlignmentScore: 0,
      maxSpreadPips: MAX_SPREAD_PIPS,
      metalsMaxSpreadPips: METALS_MAX_SPREAD_PIPS,
      pairRankOrder: rankedPairs,
      watchlist: pairs,
      defaultDisplayLotSize: DEFAULT_DISPLAY_LOT_SIZE,
      // Dynamic per-trade risk mode metadata.
      riskMode: RISK_MODE,
      minRiskPercent: MIN_RISK_PERCENT,
      maxRiskPercent: MAX_RISK_PERCENT,
      confidenceForMaxRisk: CONFIDENCE_FOR_MAX_RISK,
      accountBalanceUSD: accountBalanceUSD,
      // SL / TP / R:R are now dynamic per setup — no fixed values in meta.
      minimumRiskReward: 1.5,           // hard floor enforced by lifecycle engine
      aggressiveRiskWarning: DYNAMIC_RISK_NOTICE,
      // Entry-quality layer config — visible to the dashboard.
      entryTimingMode: ENTRY_TIMING_STRICT ? 'strict' : 'hybrid',
      newsFilterEnabled: String(process.env.FOREX_NEWS_FILTER_ENABLED ?? 'true').toLowerCase() === 'true',
      newsHighImpactBlockMinutes:    parseInt(process.env.FOREX_NEWS_HIGH_IMPACT_BLOCK_MINUTES     || '30', 10),
      newsMediumImpactCautionMinutes:parseInt(process.env.FOREX_NEWS_MEDIUM_IMPACT_CAUTION_MINUTES || '15', 10),
      postNewsConfirmationMinutes:   parseInt(process.env.FOREX_POST_NEWS_CONFIRMATION_MINUTES     || '60', 10),
      // Trading environment metadata (2026-05-27 paper-trading layer)
      environment: (process.env.FOREX_TRADING_ENVIRONMENT || 'practice').toLowerCase(),
      paperTradingAvailable: true,
      isPaperTrading: (process.env.FOREX_TRADING_ENVIRONMENT || 'practice').toLowerCase() !== 'live',
      // Signal Stack V3 self-improvement layer — calibration snapshot used
      // for this scan. The dashboard renders the monthly E[RR] vs Realized-R
      // and the active rejection threshold below.
      calibration,
      // Signal Stack V3 execution engine — mode + shadow comparison report.
      v3EngineMode: V3_MODE,
      v3Comparison: v3Report,
    },
  };

  updateSignalStore(result);
  setScanInProgress(false);

  return result;
}




// === OPPORTUNITY RANKING PATCH ===
function getNYHour(date = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      hour12: false,
    }).format(date)
  );
  return hour === 24 ? 0 : hour;
}

function isActiveOpportunityWindow(date = new Date()) {
  const h = getNYHour(date);
  return h >= 2 && h < 14;
}

function isProtectedHardBlock(reason = "") {
  const r = String(reason).toLowerCase();
  return (
    r.includes("rr < 1.5") ||
    r.includes("risk reward below") ||
    r.includes("spread too high") ||
    r.includes("duplicate") ||
    r.includes("max trades") ||
    r.includes("daily loss") ||
    r.includes("missing stop") ||
    r.includes("missing take profit") ||
    r.includes("invalid broker") ||
    r.includes("credentials") ||
    r.includes("live trading disabled") ||
    r.includes("execution disabled")
  );
}

function convertLateEntryToTradableStatus(status, reason = "", now = new Date()) {
  if (!isActiveOpportunityWindow(now)) return { status, reason };

  const s = String(status || "").toLowerCase();
  const r = String(reason || "").toLowerCase();

  if (
    s === "late_entry" ||
    r.includes("late entry") ||
    r.includes("overextended") ||
    r.includes("flow opposes") ||
    r.includes("institutional flow")
  ) {
    return {
      status: "valid_entry",
      reason: `Active-window tradable opportunity: ${reason || status}`,
      warning: true,
    };
  }

  return { status, reason };
}

function rankOpportunity(candidate = {}) {
  const rr = Number(candidate.rr ?? candidate.riskReward ?? candidate.expectedRR ?? 0);
  const confidence = Number(candidate.confidence ?? candidate.score ?? candidate.alignScore ?? 0);
  const spreadOk = candidate.spreadOk !== false;
  const duplicate = candidate.duplicate === true || candidate.hasDuplicate === true;

  if (rr < 1.5) return { mode: "NONE", score: 0, reject: "RR < 1.5" };
  if (!spreadOk) return { mode: "NONE", score: 0, reject: "spread too high" };
  if (duplicate) return { mode: "NONE", score: 0, reject: "duplicate active trade" };

  let score = 0;
  score += Math.min(confidence, 100);
  score += Math.min(rr * 12, 40);

  if (candidate.entryStatus === "valid_entry") score += 15;
  if (candidate.entryStatus === "wait_for_retest") score += 8;
  if (candidate.macroBias && candidate.direction && String(candidate.macroBias).includes(candidate.direction)) score += 10;

  if (confidence >= 70 && rr >= 1.5) {
    return { mode: "SCALP", score, reject: null };
  }

  if (confidence >= 76 && rr >= 1.5) {
    return { mode: "SWING", score, reject: null };
  }

  return { mode: "NONE", score, reject: "confidence below opportunity threshold" };
}

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function shouldUseActiveWindowV3Bridge({ v3Eval, direction, newsRisk, pricing, maxSpread, alignment } = {}) {
  if (!envBool('FOREX_ACTIVE_WINDOW_V3_BRIDGE', true)) {
    return { allowed: false, reason: 'bridge_disabled' };
  }

  if (!isActiveOpportunityWindow(new Date())) {
    return { allowed: false, reason: 'outside_active_window' };
  }

  if (!direction) {
    return { allowed: false, reason: 'missing_direction' };
  }

  if (newsRisk?.blocked) {
    return { allowed: false, reason: 'news_blocked' };
  }

  if (Number(pricing?.spreadPips ?? 999) > Number(maxSpread ?? 0)) {
    return { allowed: false, reason: 'spread_blocked' };
  }

  const score = Number(v3Eval?.score ?? 0);
  const minScore = envNumber('FOREX_ACTIVE_WINDOW_V3_MIN_SCORE', 55);
  const pdScore = Number(v3Eval?.premiumDiscount?.premiumDiscountScore ?? 0);
  const pdState = String(v3Eval?.premiumDiscount?.premiumDiscountState || '').toLowerCase();
  const liqScore = Number(v3Eval?.liquidityIntent?.intentScore ?? v3Eval?.liquidityIntent?.score ?? 0);
  const alignScore = Number(alignment?.timeframeAlignmentScore ?? 0);

  const favorablePremiumDiscount =
    (direction === 'long' && pdState === 'discount') ||
    (direction === 'short' && pdState === 'premium') ||
    pdState === 'equilibrium';

  const hasV35Opportunity =
    v3Eval?.qualified === true ||
    v3Eval?.earlyTrigger === true ||
    favorablePremiumDiscount ||
    pdScore >= 0.65 ||
    liqScore >= 0.6 ||
    alignScore >= 60;

  if (score < minScore || !hasV35Opportunity) {
    return {
      allowed: false,
      reason: `v3_not_strong_enough score=${score} min=${minScore} pd=${pdState || 'n/a'} pdScore=${pdScore} liq=${liqScore} align=${alignScore}`,
    };
  }

  return {
    allowed: true,
    reason: `v3_bridge score=${score} pd=${pdState || 'n/a'} pdScore=${pdScore} liq=${liqScore} align=${alignScore}`,
  };
}

function softenActiveWindowRejects(reasons = [], now = new Date()) {
  if (!isActiveOpportunityWindow(now)) return reasons;

  return reasons.filter((reason) => {
    const r = String(reason).toLowerCase();

    if (isProtectedHardBlock(r)) return true;

    if (
      r.includes("late_entry") ||
      r.includes("late entry") ||
      r.includes("overextended") ||
      r.includes("flow opposes") ||
      r.includes("institutional flow") ||
      r.includes("missing smt") ||
      r.includes("missing fvg") ||
      r.includes("mixed ema") ||
      r.includes("structural confidence") ||
      r.includes("execution confidence") ||
      r.includes("structural reversal risk") ||
      r.includes("reversal risk is high") ||
      r.includes("candle has strong") ||
      r.includes("candle strength") ||
      r.includes("profile floor") ||
      r.includes("profile does not allow reversal_risk") ||
      r.includes("market state is reversal_risk") ||
      r.includes("forex profile does not allow reversal_risk") ||
      r.includes("liquidity proxy")
    ) {
      return false;
    }

    return true;
  });
}
// === END OPPORTUNITY RANKING PATCH ===



function prioritizeRetraceWatchPairs(pairs = []) {
  const watched = getRetraceWatchPairs();
  return [...new Set([...watched, ...pairs])];
}
