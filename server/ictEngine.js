/**
 * server/ictEngine.js
 *
 * ICT Engine — standalone, ICT-first analysis. Completely isolated from the
 * V3/V3.5 execution engine: it reuses V3's PURE detectors read-only and never
 * mutates V3 scoring, and it has NO execution path (shadow analysis only — it
 * never trades).
 *
 *   analyzeICTPair({ pair, candles, peers, now })  → one pair's ICT analysis
 *   analyzeICTPairs(pairs, { client })              → fetch + analyse a batch
 *
 * ICT logic priority (spec): HTF bias → liquidity map → sweep → displacement →
 * MSS/BOS/CHOCH → PD arrays (FVG/OB/inducement) → premium/discount → OTE →
 * killzone/macro timing → generate or reject. No RSI/MACD/EMA qualifiers.
 *
 * Response object (exact spec shape) plus additive `concepts`, `timing`,
 * `killzone`, `macro`, and `v3Comparison` for the dashboard.
 */

import { getCandles } from './oandaMarketData.js';
import { getPipSize, toPips, roundPrice } from './pipMath.js';
import { atr } from './oandaIndicators.js';
import { analyzeLiquidity } from './liquidityEngine.js';
import { detectBreakOfStructure, detectChangeOfCharacter } from './oandaInstitutionalFlow.js';
import { detectFibSetup } from './oandaFibonacci.js';
// NOTE: ICT is a fully independent engine. It must NOT import V3 (no evaluateV3,
// no V3 scoring/confirmation/trend/shadow comparison). Any V3-vs-ICT comparison
// is display-only and computed OUTSIDE this engine (see server/v3IctComparison.js).
import { currentKillzone, activeMacro, inSilverBulletWindow } from './ictTime.js';
import {
  detectFVGs, detectDisplacement, detectOrderBlock, detectMSS, detectInducement,
  detectTurtleSoup, detectJudasSwing, classifyPowerOf3, computePremiumDiscount,
  computeOTE, buildLiquidityMap, irlErlDraw, computeDailyBias, htfBias, candleContext,
} from './ictConcepts.js';
import { detectSMT, correlatedPeers } from './ictSMT.js';
import { getNewsRisk } from './news/forexFactoryNews.js';

// shadow = analysis only (default); live = analysis + (gated) execution.
export const ICT_MODE = String(process.env.ICT_ENGINE_MODE || 'shadow').toLowerCase();
export function isIctEnabled() { return ICT_MODE === 'shadow' || ICT_MODE === 'live'; }

// ── Execution flags (all default to OFF/safe) ────────────────────────────────
// Reading via getters keeps tests able to override process.env per-case, and
// keeps a single source of truth for the route/executor.
export function ictExecConfig() {
  return {
    mode: ICT_MODE,
    autoTradeEnabled: String(process.env.ICT_AUTO_TRADE_ENABLED || 'false').toLowerCase() === 'true',
    minConfidence: parseFloat(process.env.ICT_MIN_CONFIDENCE || '80'),
    minRR: parseFloat(process.env.ICT_MIN_RR || '2.0'),
    maxRiskPercent: parseFloat(process.env.ICT_MAX_RISK_PERCENT || '1'),
    signalTtlSec: parseFloat(process.env.ICT_SIGNAL_TTL_SEC || '300'),
  };
}

/** Execution requires BOTH live mode AND the auto-trade flag. Off by default. */
export function isIctExecutionEnabled() {
  const c = ictExecConfig();
  return c.mode === 'live' && c.autoTradeEnabled === true;
}

const MIN_RR = parseFloat(process.env.ICT_MIN_RR || '2.0');

const DEFAULT_ICT_PAIRS = ['EUR_USD', 'GBP_USD', 'USD_JPY', 'AUD_USD', 'USD_CAD', 'XAU_USD', 'XAG_USD'];
const ICT_PAIRS = (process.env.ICT_PAIRS || process.env.FOREX_WATCHLIST)
  ? (process.env.ICT_PAIRS || process.env.FOREX_WATCHLIST).split(',').map((p) => p.trim()).filter(Boolean)
  : DEFAULT_ICT_PAIRS;

const sign = (d) => (d === 'long' || d === 'bullish' ? 'bullish' : d === 'short' || d === 'bearish' ? 'bearish' : null);
const toLS = (b) => (b === 'bullish' ? 'long' : b === 'bearish' ? 'short' : null);

// ─── Trade levels from the PD array in the bias direction ────────────────────
function computeSetup({ dir, pair, currentPrice, atrPrice, fvgs, orderBlock, ote, liquidityMap, sweep }) {
  const pip = getPipSize(pair);
  const buffer = Math.max(atrPrice ? atrPrice * 0.25 : 0, 5 * pip);
  const bull = dir === 'long';

  // Entry zone: prefer an unfilled FVG in-direction, then an unmitigated OB, then OTE.
  const fvg = (fvgs || []).find((f) => f.type === (bull ? 'bullish' : 'bearish') && f.status !== 'filled');
  let zoneMid = null, zoneLow = null, zoneHigh = null, entrySource = null;
  if (fvg) { zoneMid = fvg.midpoint; zoneLow = fvg.low; zoneHigh = fvg.high; entrySource = 'FVG'; }
  else if (orderBlock && orderBlock.type === (bull ? 'bullish' : 'bearish') && !orderBlock.mitigated) {
    zoneMid = orderBlock.midpoint; zoneLow = orderBlock.low; zoneHigh = orderBlock.high; entrySource = 'OB';
  } else if (ote && ote.priceInOTE) {
    zoneMid = (ote.oteLow + ote.oteHigh) / 2; zoneLow = ote.oteLow; zoneHigh = ote.oteHigh; entrySource = 'OTE';
  }
  if (zoneMid == null) return { ok: false, reason: 'No PD array (FVG/OB/OTE) available for entry.' };

  const entry = roundPrice(zoneMid, pair);
  const sweptLevel = Number.isFinite(sweep?.sweptPriceLevel) ? sweep.sweptPriceLevel : null;

  // Target = nearest opposing liquidity in-direction (ERL).
  const targetPool = bull
    ? (liquidityMap.buySideLiquidity || []).find((p) => p.price > entry)
    : (liquidityMap.sellSideLiquidity || []).find((p) => p.price < entry);
  const target2Pool = bull
    ? (liquidityMap.buySideLiquidity || []).filter((p) => p.price > entry).find((p) => p.major)
    : (liquidityMap.sellSideLiquidity || []).filter((p) => p.price < entry).find((p) => p.major);
  if (!targetPool) return { ok: false, reason: 'No opposing liquidity target in the bias direction.' };

  // Stop beyond the protected liquidity (zone edge / swept level), never inside it.
  const stopLoss = bull
    ? roundPrice(Math.min(zoneLow, sweptLevel ?? zoneLow) - buffer, pair)
    : roundPrice(Math.max(zoneHigh, sweptLevel ?? zoneHigh) + buffer, pair);

  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(targetPool.price - entry);
  if (risk <= 0) return { ok: false, reason: 'Degenerate stop distance.' };
  const rr = +(reward / risk).toFixed(2);

  return {
    ok: true,
    entrySource,
    entry,
    stopLoss,
    target1: targetPool.price,
    target1Label: targetPool.label,
    target2: target2Pool ? target2Pool.price : null,
    target2Label: target2Pool ? target2Pool.label : null,
    rr,
    riskPips: toPips(risk, pair),
    rewardPips: toPips(reward, pair),
  };
}

// ─── One pair ────────────────────────────────────────────────────────────────
export function analyzeICTPair({ pair, candles, peers = {}, now = new Date() }) {
  const monthly = candles.monthly || [];
  const daily = candles.daily || [];
  const h4 = candles.h4 || [];
  const h1 = candles.h1 || [];
  const m15 = candles.m15 || [];
  const m5 = candles.m5 || [];

  const currentPrice = m5.length ? m5[m5.length - 1].close
    : m15.length ? m15[m15.length - 1].close : null;
  const generatedAtMs = (now instanceof Date ? now : new Date(now)).getTime();
  const timestamp = new Date(generatedAtMs).toISOString();
  const signalId = `${pair}:${generatedAtMs}`;

  if (!Number.isFinite(currentPrice) || m15.length < 25) {
    return blankAnalysis(pair, timestamp, 'Insufficient candle data for ICT analysis.');
  }

  // Entry timing runs on 5M only (fall back to M15 if 5M is thin). 5M never
  // sets or overrides direction — that comes from the Daily+4H agreement below.
  const entryTf = m5.length >= 30 ? m5 : m15;
  const atrPrice = atr(entryTf, 14) || null;
  const atrPips = atrPrice ? toPips(atrPrice, pair) : null;

  // 1. HTF directional bias — Daily and 4H must AGREE (this sets direction).
  const dailyTfBias = htfBias(daily);
  const h4TfBias = htfBias(h4);
  const htfAligned = dailyTfBias !== 'neutral' && dailyTfBias === h4TfBias;
  const dir = htfAligned ? toLS(dailyTfBias) : null;

  // 2. Liquidity map (pools from D/H4/H1/session); sweep + equal-levels on 5M.
  const analyzed = analyzeLiquidity({ pair, dailyCandles: daily, h4Candles: h4, h1Candles: h1, m15Candles: entryTf, currentPrice, atrPips });
  const liquidityMap = buildLiquidityMap({ pair, currentPrice, analyzed, monthlyCandles: monthly });
  const bias = computeDailyBias({ pair, currentPrice, dailyCandles: daily, h4Candles: h4, liquidityMap }); // draw-on-liquidity display

  // 3. Sweep (pool-aware, on the 5M entry timeframe).
  const sweep = analyzed.liquiditySweep || null;
  const sweepDir = sweep?.pending ? null : sweep?.direction || null;
  const pendingSweepDir = sweep?.pending ? sweep.direction : null;

  // 4. Entry-timing concepts — 5M only.
  const displacement = detectDisplacement({ candles: entryTf, pair });
  const mss = detectMSS({ candles: entryTf, pair });
  const bos = detectBreakOfStructure({ candles: entryTf, direction: dir || 'long', pair })
    || detectBreakOfStructure({ candles: entryTf, direction: 'short', pair });
  const choch = detectChangeOfCharacter({ candles: entryTf, priorTrend: dailyTfBias === 'bullish' ? 'bullish' : 'bearish', pair });
  const fvgs = detectFVGs({ candles: entryTf, pair, timeframe: '5M' });
  const orderBlock = detectOrderBlock({ candles: entryTf, pair });
  const inducement = detectInducement({ candles: entryTf, pair, currentPrice, liquidityMap });

  // 5. Premium/Discount + OTE (fib swing in the HTF direction).
  const fib = dir ? safeFib({ direction: dir, h1Candles: h1, h4Candles: h4, currentPrice, pair }) : null;
  const premiumDiscount = computePremiumDiscount({ pair, currentPrice, fib });
  const ote = computeOTE({ pair, currentPrice, fib, direction: dir });

  // 6. Killzone / macro timing + session models + news + informational candle.
  const kz = currentKillzone(now);
  const macro = activeMacro(now);
  const silverBulletWindow = inSilverBulletWindow(now);
  const powerOf3 = classifyPowerOf3({ h1Candles: h1, pair, now });
  const judas = detectJudasSwing({ h1Candles: h1, pair });
  const turtleSoup = detectTurtleSoup({ candles: entryTf, pair, liquidityMap });
  const smt = detectSMT({ pair, candles: m15, peers });
  const news = getNewsRisk({ pair, now });
  const candle = candleContext(entryTf);

  // IRL/ERL draw.
  const irlErl = irlErlDraw({ pair, currentPrice, liquidityMap, fvgs, orderBlock, bias: sign(dir) });

  // ── 10. Generate or reject ──────────────────────────────────────────────────
  const rejectionReasons = [];
  const conceptsDetected = [];
  const note = (c) => conceptsDetected.push(c);

  if (sweep) note(`Liquidity sweep (${sweep.sweptLiquidity || 'recent extreme'})`);
  if (displacement.direction) note(`Displacement ${displacement.direction}`);
  if (mss.confirmed) note(`MSS ${mss.direction}`);
  if (bos) note(`BOS ${bos.direction}`);
  if (choch) note(`CHoCH ${choch.direction}`);
  if (fvgs.length) note(`${fvgs[0].type} FVG`);
  if (orderBlock.type) note(`${orderBlock.type} OB`);
  if (inducement.inducementPresent) note('Inducement');
  if (premiumDiscount.currentZone && premiumDiscount.currentZone !== 'unknown') note(`${premiumDiscount.currentZone} zone`);
  if (ote.priceInOTE) note('OTE');
  if (kz.inKillzone) note(`Killzone: ${kz.currentKillzone}`);
  if (macro.activeMacro) note(macro.activeMacro);
  if (turtleSoup.turtleSoupDetected) note('Turtle Soup');
  if (judas.judasSwingDetected) note('Judas Swing');
  if (smt.smtDetected) note(`SMT vs ${smt.comparisonAsset}`);
  if (htfAligned) note(`Daily+4H aligned (${dailyTfBias})`);
  if (news.caution) note('News caution');

  let signal = 'none';
  let setupType = null;
  let setup = null;

  // Direction comes ONLY from Daily+4H agreement. 5M cannot set or override it.
  if (!htfAligned) {
    rejectionReasons.push('Daily and 4H directional bias are not aligned.');
  }
  // ForexFactory high-impact news blocks; medium is caution-only (handled above).
  if (news.blocked) {
    rejectionReasons.push(news.blockReason);
  }

  if (htfAligned) {
    const want = sign(dir);
    const reversalConfirmed = (mss.confirmed && mss.direction === want) || (choch && choch.direction === want);

    // 5M entry timing only — never re-derives direction.
    if (!(sweepDir === want)) {
      if (pendingSweepDir === want) {
        rejectionReasons.push(
          want === 'bullish'
            ? 'Sell-side liquidity pierced — waiting for reclaim close.'
            : 'Buy-side liquidity pierced — waiting for reclaim close.'
        );
      } else {
        rejectionReasons.push(
          want === 'bullish'
            ? 'Sell-side liquidity not swept.'
            : 'Buy-side liquidity not swept.'
        );
      }
    }

    if (displacement.direction !== want) {
      rejectionReasons.push(`No ${want} displacement confirmed.`);
    }

    if (!reversalConfirmed && !(bos && bos.direction === want)) {
      rejectionReasons.push(`No ${want} MSS / CHoCH / BOS confirmation.`);
    }

    const hasArray = fvgs.some((f) => f.type === want && f.status !== 'filled')
      || (orderBlock.type === want && !orderBlock.mitigated);

    if (!hasArray) {
      rejectionReasons.push(`No ${want} FVG or OB available for entry.`);
    }
    
    // Premium/discount location.
    const goodZone = want === 'bullish'
      ? (premiumDiscount.currentZone === 'discount' || ote.priceInOTE)
      : (premiumDiscount.currentZone === 'premium' || ote.priceInOTE);
    if (!goodZone && premiumDiscount.currentZone !== 'unknown') {
      rejectionReasons.push(want === 'bullish'
        ? 'Long in premium without OTE / strong continuation.'
        : 'Short in discount without OTE / strong continuation.');
    }
    // Inducement must be swept first.
    if (inducement.inducementPresent && !inducement.inducementSwept) {
      rejectionReasons.push('Inducement not yet swept — premature entry.');
    }
    // Session timing (killzone) unless a strong HTF reversal narrative.
    const strongNarrative = reversalConfirmed && bias.confidence >= 60;
    if (!kz.inKillzone && !strongNarrative) {
      rejectionReasons.push('Setup formed outside a killzone with weak narrative.');
    }

    // Compute levels even if some soft checks failed, to surface timing/RR data.
    setup = computeSetup({ dir, pair, currentPrice, atrPrice, fvgs, orderBlock, ote, liquidityMap, sweep });
    if (!setup.ok) {
      rejectionReasons.push(setup.reason);
    } else {
      if (setup.rr < MIN_RR) rejectionReasons.push(`RR ${setup.rr} below minimum ${MIN_RR}.`);
      // Chasing displacement: price already left the entry zone toward target.
      const dist = want === 'bullish' ? setup.target1 - currentPrice : currentPrice - setup.target1;
      const entryDist = Math.abs(currentPrice - setup.entry);
      if (atrPrice && entryDist > atrPrice * 2) {
        rejectionReasons.push('Price has run from the PD array — chasing displacement, not retracing.');
      }
      void dist;
    }

    if (rejectionReasons.length === 0 && setup.ok) {
      signal = want === 'bullish' ? 'buy' : 'sell';
      setupType = silverBulletWindow ? 'Silver Bullet'
        : turtleSoup.turtleSoupDetected ? 'Turtle Soup'
        : judas.judasSwingDetected ? 'Judas Reversal'
        : reversalConfirmed ? 'MSS Reversal'
        : 'OTE Continuation';
    }
  }

  // Silver Bullet detail object (spec shape).
  const silverBullet = {
    activeWindow: silverBulletWindow,
    direction: signal === 'buy' ? 'bullish' : signal === 'sell' ? 'bearish' : null,
    fvgEntry: silverBulletWindow && setup?.ok && setup.entrySource === 'FVG' ? setup.entry : null,
    stopLoss: silverBulletWindow && setup?.ok ? setup.stopLoss : null,
    liquidityTarget: silverBulletWindow && setup?.ok ? setup.target1 : null,
    confidence: silverBulletWindow && signal !== 'none' ? 80 : 0,
  };

  // Timing grade.
  const timing = gradeTiming({ pair, currentPrice, setup, atrPrice });

  // Confidence (only meaningful when a signal forms).
  const confidence = signal === 'none' ? 0 : Math.round(Math.min(100,
    40
    + (kz.killzoneQuality / 100) * 20
    + (displacement.displacementScore / 100) * 15
    + (ote.oteQuality / 100) * 10
    + (bias.confidence / 100) * 10
    + Math.min(5, conceptsDetected.length),
  ));

  const ictBias = htfAligned ? dailyTfBias : 'neutral';
  const ictNarrative = buildNarrative({ pair, dir, bias, sweep, displacement, mss, choch, premiumDiscount, ote, kz, irlErl, signal, setupType });

  // ICT is fully independent — V3 is never consulted here. Any V3-vs-ICT
  // comparison is display-only and merged by the API route (see v3IctComparison.js).
  const v3Comparison = null;

  // Spec logging: ICT mode, auto-trade, independence, Daily/4H bias, 5M confirmation.
  console.log(
    `[ICT] ${pair} mode=${ICT_MODE} autoTrade=${ictExecConfig().autoTradeEnabled} independentFromV3=true | ` +
    `dailyBias=${dailyTfBias} h4Bias=${h4TfBias} aligned=${htfAligned} | ` +
    `5M=${signal !== 'none' ? 'confirmed' : 'none'} signal=${signal}${news.blocked ? ' [NEWS-BLOCK]' : news.caution ? ' [news-caution]' : ''}`,
  );

  return {
    pair, timestamp, signalId, generatedAtMs,
    ictBias,
    ictNarrative,
    setupType,
    signal,
    entry: setup?.ok ? setup.entry : null,
    stopLoss: setup?.ok ? setup.stopLoss : null,
    target1: setup?.ok ? setup.target1 : null,
    target2: setup?.ok ? setup.target2 : null,
    rr: setup?.ok ? setup.rr : null,
    confidence,
    conceptsDetected,
    rejectionReasons,
    // additive bundle for the dashboard
    concepts: {
      liquidityMap, sweep, displacement, mss, bos, choch, fvgs, orderBlock,
      inducement, premiumDiscount, ote, powerOf3, killzone: kz, macro,
      silverBullet, smt, turtleSoup, judas, irlErl, dailyBias: bias,
      htf: { dailyBias: dailyTfBias, h4Bias: h4TfBias, aligned: htfAligned },
      news, candle,
    },
    timing,
    v3Comparison,
    mode: ICT_MODE,
  };
}

function gradeTiming({ pair, currentPrice, setup, atrPrice }) {
  if (!setup?.ok) return { lateEntryRisk: null, distanceToTarget: null, distanceToStop: null, timingGrade: 'n/a' };
  const distanceToTarget = toPips(setup.target1 - currentPrice, pair);
  const distanceToStop = toPips(currentPrice - setup.stopLoss, pair);
  const entryDist = atrPrice ? Math.abs(currentPrice - setup.entry) / atrPrice : 0;
  const lateEntryRisk = entryDist > 2 ? 'high' : entryDist > 1 ? 'medium' : 'low';
  const timingGrade = lateEntryRisk === 'low' && setup.rr >= 2.5 ? 'A'
    : lateEntryRisk === 'low' ? 'B'
    : lateEntryRisk === 'medium' ? 'C' : 'D';
  return { lateEntryRisk, distanceToTarget, distanceToStop, timingGrade };
}

function buildNarrative({ pair, dir, bias, sweep, displacement, mss, choch, premiumDiscount, ote, kz, irlErl, signal, setupType }) {
  const bits = [];
  bits.push(`${pair} daily bias ${bias.dailyBias}`);
  if (sweep) bits.push(`swept ${sweep.sweptLiquidity || 'liquidity'} (${sweep.direction})`);
  if (displacement.direction) bits.push(`${displacement.direction} displacement`);
  if (mss.confirmed) bits.push(`MSS ${mss.direction}`);
  else if (choch) bits.push(`CHoCH ${choch.direction}`);
  if (premiumDiscount.currentZone !== 'unknown') bits.push(`price in ${premiumDiscount.currentZone}`);
  if (ote.priceInOTE) bits.push('inside OTE');
  if (kz.inKillzone) bits.push(`${kz.currentKillzone} killzone`);
  if (irlErl?.nextTarget) bits.push(`drawing toward ${irlErl.currentDraw} ${irlErl.nextTarget.label}`);
  const head = signal === 'none' ? '✗ No ICT setup' : `✓ ICT ${signal.toUpperCase()}${setupType ? ` (${setupType})` : ''}`;
  return `${head} — ${bits.join(', ')}.`;
}

function safeFib(args) { try { return detectFibSetup(args); } catch { return null; } }

function blankAnalysis(pair, timestamp, reason) {
  const generatedAtMs = Date.parse(timestamp) || 0;
  return {
    pair, timestamp, signalId: `${pair}:${generatedAtMs}`, generatedAtMs,
    ictBias: 'neutral', ictNarrative: `${pair}: ${reason}`,
    setupType: null, signal: 'none', entry: null, stopLoss: null, target1: null,
    target2: null, rr: null, confidence: 0, conceptsDetected: [], rejectionReasons: [reason],
    concepts: null, timing: { lateEntryRisk: null, distanceToTarget: null, distanceToStop: null, timingGrade: 'n/a' },
    v3Comparison: null, mode: ICT_MODE,
  };
}

// ─── Batch (fetch + analyse) ─────────────────────────────────────────────────
const TF = [
  ['monthly', 'M', 6], ['weekly', 'W', 12], ['daily', 'D', 60],
  ['h4', 'H4', 60], ['h1', 'H1', 120], ['m15', 'M15', 160], ['m5', 'M5', 120],
];

export async function analyzeICTPairs(pairs = null, { client, now = new Date() } = {}) {
  const list = Array.isArray(pairs) && pairs.length ? pairs : ICT_PAIRS;

  // Fetch all timeframes for all pairs.
  const candleByPair = {};
  await Promise.all(list.map(async (pair) => {
    const sets = await Promise.all(TF.map(([, g, n]) => getCandles(pair, g, n, { client }).catch(() => [])));
    const c = {};
    TF.forEach(([key], i) => { c[key] = sets[i]; });
    candleByPair[pair] = c;
  }));

  const analyses = [];
  for (const pair of list) {
    try {
      // Build the SMT peer map from already-fetched correlated pairs (M15).
      const peers = {};
      for (const peer of correlatedPeers(pair)) {
        if (candleByPair[peer]?.m15) peers[peer] = candleByPair[peer].m15;
      }
      analyses.push(analyzeICTPair({ pair, candles: candleByPair[pair] || {}, peers, now }));
    } catch (err) {
      analyses.push(blankAnalysis(pair, new Date().toISOString(), `ICT analysis error: ${err.message}`));
    }
  }

  return {
    analyses,
    meta: {
      ictEngineMode: ICT_MODE,
      executionEnabled: isIctExecutionEnabled(),
      pairsAnalyzed: list.length,
      generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
      signals: analyses.filter((a) => a.signal !== 'none').length,
    },
  };
}
