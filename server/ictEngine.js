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

import { getIctCandles } from './ictMarketData.js';
import { getPipSize, pricePrecision, toPips, roundPrice } from './pipMath.js';
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
import { classifyIctStrategy, computeAdaptiveIctStop } from './ictPolicy.js';
import { computeIctTargetHitConfidence } from './ictTargetConfidence.js';
import { getNewsRisk } from './news/forexFactoryNews.js';
import { configuredIctWatchlist } from './ictWatchlist.js';
import { getIctInstrumentMeta } from './ictInstrumentCatalog.js';
import { classifyIctHourlyEntryTransition } from './ictHourlyEntry.js';

// shadow = analysis only (default); live = analysis + (gated) execution.
export const ICT_MODE = String(process.env.ICT_ENGINE_MODE || 'shadow').toLowerCase();
export function isIctEnabled() { return ICT_MODE === 'shadow' || ICT_MODE === 'active' || ICT_MODE === 'live'; }

// Signal Stack policy: R:R is a ratio, not a percentage. Every generated ICT
// setup is constructed at a minimum of 1:1.5 before qualification/execution.
export const ICT_MIN_RR = 1.5;
export function configuredIctMinRR() {
  const configured = parseFloat(process.env.ICT_MIN_RR || '1.5');
  return Number.isFinite(configured) ? Math.max(ICT_MIN_RR, configured) : ICT_MIN_RR;
}

/**
 * Extend a technically valid target to the configured minimum R:R when the
 * nearest liquidity target is too close. This changes take-profit only; the
 * structure-derived entry and stop remain authoritative.
 */
export function enforceMinimumRRTarget({ pair, direction, entry, stopLoss, target, minRR = configuredIctMinRR() }) {
  const bull = direction === 'long' || direction === 'bullish' || direction === 'buy';
  const bear = direction === 'short' || direction === 'bearish' || direction === 'sell';
  const entryPrice = Number(entry);
  const stopPrice = Number(stopLoss);
  const rawTarget = Number(target);
  const floor = Number(minRR);

  if (!bull && !bear) return { ok: false, reason: 'Invalid trade direction for R:R target construction.' };
  if (![entryPrice, stopPrice, rawTarget, floor].every(Number.isFinite) || floor < ICT_MIN_RR) {
    return { ok: false, reason: 'Invalid price or minimum R:R input.' };
  }

  const geometryOK = bull
    ? stopPrice < entryPrice && rawTarget > entryPrice
    : stopPrice > entryPrice && rawTarget < entryPrice;
  if (!geometryOK) return { ok: false, reason: 'Invalid entry/stop/target geometry.' };

  const risk = Math.abs(entryPrice - stopPrice);
  if (risk <= 0) return { ok: false, reason: 'Degenerate stop distance.' };

  const minimumTarget = bull
    ? entryPrice + (risk * floor)
    : entryPrice - (risk * floor);
  const selectedTarget = bull
    ? Math.max(rawTarget, minimumTarget)
    : Math.min(rawTarget, minimumTarget);

  const tick = 10 ** (-pricePrecision(pair));
  let adjustedTarget = roundPrice(selectedTarget, pair);
  let reward = Math.abs(adjustedTarget - entryPrice);

  // Rounding can place the target one tick inside the floor. Step outward until
  // the executable, rounded price is truly at or above the minimum R:R.
  let safety = 0;
  while ((reward / risk) < (floor - 1e-9) && safety < 3) {
    adjustedTarget = roundPrice(adjustedTarget + (bull ? tick : -tick), pair);
    reward = Math.abs(adjustedTarget - entryPrice);
    safety += 1;
  }

  const rr = +(reward / risk).toFixed(2);
  if (rr < floor) return { ok: false, reason: `Could not construct minimum ${floor.toFixed(1)}R target after rounding.` };

  return {
    ok: true,
    target: adjustedTarget,
    rr,
    risk,
    reward,
    minimumTarget,
    rawTarget,
    adjusted: bull ? rawTarget < minimumTarget : rawTarget > minimumTarget,
  };
}


// ── Execution flags (all default to OFF/safe) ────────────────────────────────
// Reading via getters keeps tests able to override process.env per-case, and
// keeps a single source of truth for the route/executor.
export function ictExecConfig() {
  return {
    mode: ICT_MODE,
    autoTradeEnabled: String(process.env.ICT_AUTO_TRADE_ENABLED || 'false').toLowerCase() === 'true',
    // Operational ICT qualification floor. Entry-timing gates remain mandatory.
    minConfidence: 80,
    minRR: configuredIctMinRR(),
    maxRiskPercent: parseFloat(process.env.ICT_MAX_RISK_PERCENT || '1.4'),
    signalTtlSec: parseFloat(process.env.ICT_SIGNAL_TTL_SEC || '300'),
  };
}

/** Execution requires BOTH live mode AND the auto-trade flag. Off by default. */
export function isIctExecutionEnabled() {
  const c = ictExecConfig();
  return (c.mode === 'active' || c.mode === 'live') && c.autoTradeEnabled === true;
}

const ICT_PAIRS = configuredIctWatchlist();

const sign = (d) => (d === 'long' || d === 'bullish' ? 'bullish' : d === 'short' || d === 'bearish' ? 'bearish' : null);
const toLS = (b) => (b === 'bullish' ? 'long' : b === 'bearish' ? 'short' : null);

// ─── Trade levels from the PD array in the bias direction ────────────────────
function computeSetup({ dir, pair, currentPrice, atrPrice, fvgs, orderBlock, ote, liquidityMap, sweep, candles }) {
  const pip = getPipSize(pair);
  const bull = dir === 'long';

  // Entry zone: prefer an unfilled FVG in-direction, then an unmitigated OB, then OTE.
  const fvg = (fvgs || []).find((f) => f.type === (bull ? 'bullish' : 'bearish') && f.status !== 'filled');
  let zoneMid = null, zoneLow = null, zoneHigh = null, entrySource = null;
  const sweptLevel = Number.isFinite(sweep?.sweptPriceLevel) ? sweep.sweptPriceLevel : null;
  if (fvg) { zoneMid = fvg.midpoint; zoneLow = fvg.low; zoneHigh = fvg.high; entrySource = 'FVG'; }
  else if (orderBlock && orderBlock.type === (bull ? 'bullish' : 'bearish') && !orderBlock.mitigated) {
    zoneMid = orderBlock.midpoint; zoneLow = orderBlock.low; zoneHigh = orderBlock.high; entrySource = 'OB';
  } else if (ote && ote.priceInOTE) {
    zoneMid = (ote.oteLow + ote.oteHigh) / 2; zoneLow = ote.oteLow; zoneHigh = ote.oteHigh; entrySource = 'OTE';
  } else {
    // No PD array — a PD array is CONFLUENCE, not required. Enter at market with a
    // structure/ATR stop (beyond the swept level when present).
    const buf = atrPrice ? atrPrice * 1.5 : (sweptLevel != null ? Math.abs(currentPrice - sweptLevel) : currentPrice * 0.002);
    zoneMid = currentPrice;
    zoneLow = bull ? currentPrice - buf : currentPrice;
    zoneHigh = bull ? currentPrice : currentPrice + buf;
    entrySource = 'MARKET';
  }

  // ICT submits MARKET orders. The executable entry is therefore the current
  // market price, while the PD-array midpoint is retained only as the ideal entry
  // reference used to detect late/chasing entries.
  const idealEntry = roundPrice(zoneMid, pair);
  const entry = roundPrice(currentPrice, pair);

  // Target = nearest opposing liquidity in-direction (ERL).
  const targetPool = bull
    ? (liquidityMap.buySideLiquidity || []).find((p) => p.price > entry)
    : (liquidityMap.sellSideLiquidity || []).find((p) => p.price < entry);
  const target2Pool = bull
    ? (liquidityMap.buySideLiquidity || []).filter((p) => p.price > entry).find((p) => p.major)
    : (liquidityMap.sellSideLiquidity || []).filter((p) => p.price < entry).find((p) => p.major);
  if (!targetPool) return { ok: false, reason: 'No opposing liquidity target in the bias direction.' };

  // Stop beyond true structural invalidation with an adaptive ATR/liquidity-raid buffer.
  // This is calculated before entry; an open protective stop is never widened.
  const adaptiveStop = computeAdaptiveIctStop({
    pair, direction: dir, entry, zoneLow, zoneHigh, sweptLevel, atrPrice,
    pipSize: pip, candles, sweep,
  });
  if (!adaptiveStop.ok) return adaptiveStop;
  const stopLoss = roundPrice(adaptiveStop.stopLoss, pair);

  const targetPolicy = enforceMinimumRRTarget({
    pair,
    direction: dir,
    entry,
    stopLoss,
    target: targetPool.price,
    minRR: configuredIctMinRR(),
  });
  if (!targetPolicy.ok) return targetPolicy;

  const {
    target: target1,
    rr,
    risk,
    reward,
    rawTarget: rawLiquidityTarget,
    adjusted: targetAdjustedToMinRR,
  } = targetPolicy;

  const target2Price = target2Pool ? Number(target2Pool.price) : null;
  const target2IsBeyondTarget1 = Number.isFinite(target2Price) && (
    bull ? target2Price > target1 : target2Price < target1
  );

  return {
    ok: true,
    entrySource,
    entry,
    idealEntry,
    entryZoneLow: roundPrice(zoneLow, pair),
    entryZoneHigh: roundPrice(zoneHigh, pair),
    stopLoss,
    target1,
    target1Label: targetAdjustedToMinRR
      ? `${targetPool.label} (extended to ${configuredIctMinRR().toFixed(1)}R minimum)`
      : targetPool.label,
    target2: target2IsBeyondTarget1 ? target2Price : null,
    target2Label: target2IsBeyondTarget1 ? target2Pool.label : null,
    rr,
    riskPips: toPips(risk, pair),
    rewardPips: toPips(reward, pair),
    rawLiquidityTarget,
    targetAdjustedToMinRR,
    minimumRR: configuredIctMinRR(),
    riskModel: adaptiveStop,
  };
}

// ─── Confidence scoring (soft confluence) ────────────────────────────────────
// PURE. Base from the required Daily+4H alignment + killzone, then additive
// bonuses for every confluence factor. Nothing here rejects — the hard gates do
// that. Display and auto-execution qualify only at >=85.
export function computeIctConfidence(p = {}) {
  if (!p.htfAligned) return 0;
  let c = 40;                                          // Daily+4H aligned (hard-gated base)
  c += Math.round((p.killzoneQuality || 0) * 0.15);    // active killzone quality (~8–14)
  c += p.sweepAligned ? 12 : (p.drawPresent ? 6 : 0);  // liquidity sweep / draw on liquidity
  c += p.entryTrigger ? 8 : 0;                         // 5M entry-timing confirmation
  c += p.hourlyTransition ? 6 : 0;                     // fresh H1 countertrend → HTF-bias turn
  if (p.displacementAligned) c += 8;
  if (p.mssOrChoch) c += 6;
  if (p.fvgInDir) c += 5;
  if (p.obInDir) c += 5;
  if (p.inOteZone) c += 8;
  if (p.smt) c += 4;
  if (p.inducementSwept) c += 3;
  c += Math.min(6, (p.labels || 0) * 3);               // Power3 / SilverBullet / TurtleSoup / Judas labels
  if (Number.isFinite(p.rr) && p.rr >= 2) c += 4;
  return Math.max(0, Math.min(100, Math.round(c)));
}

// ─── One pair ────────────────────────────────────────────────────────────────
export function analyzeICTPair({ pair, candles, peers = {}, now = new Date() }) {
  const monthly = candles.monthly || [];
  const daily = candles.daily || [];
  const h4 = candles.h4 || [];
  const h1 = candles.h1 || [];
  const m15 = candles.m15 || [];
  const m5 = candles.m5 || [];

  const liveH1 = h1.at(-1)?.complete === false ? h1.at(-1) : null;
  const currentPrice = Number.isFinite(Number(liveH1?.close)) ? Number(liveH1.close)
    : m5.length ? m5[m5.length - 1].close
      : m15.length ? m15[m15.length - 1].close : null;
  const generatedAtMs = (now instanceof Date ? now : new Date(now)).getTime();
  const timestamp = new Date(generatedAtMs).toISOString();
  const signalId = `${pair}:${generatedAtMs}`;
  const instrumentMeta = getIctInstrumentMeta(pair);

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
  // H1 structure is exposed for dashboard context only. It never sets or
  // overrides direction; only the Daily/4H agreement owns the trade bias.
  const completedH1 = h1.filter((candle) => candle?.complete !== false);
  const h1TfBias = htfBias(completedH1.length ? completedH1 : h1);
  const htfAligned = dailyTfBias !== 'neutral' && dailyTfBias === h4TfBias;
  const dir = htfAligned ? toLS(dailyTfBias) : null;
  const analysisDirection = dir === 'long' ? 'buy' : dir === 'short' ? 'sell' : 'none';
  const h1Transition = classifyIctHourlyEntryTransition({
    h1Candles: h1,
    bias: htfAligned ? dailyTfBias : null,
    now,
  });

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
  if (h1Transition.ready) note(`H1 countertrend-to-${dailyTfBias} transition`);
  if (news.caution) note('News caution');

  let signal = 'none';
  let setupType = null;
  let setup = null;

  const want = sign(dir); // null when Daily/4H not aligned
  const reversalConfirmed = !!want && ((mss.confirmed && mss.direction === want) || (choch && choch.direction === want));
  const bosAligned = !!(want && bos && bos.direction === want);
  const sweepAligned = !!want && sweepDir === want;

  // Draw on liquidity: a target pool sits in the trade direction (price is drawn to it).
  const drawTarget = want === 'bullish'
    ? (liquidityMap.buySideLiquidity || []).find((p) => p.price > currentPrice)
    : want === 'bearish' ? (liquidityMap.sellSideLiquidity || []).find((p) => p.price < currentPrice) : null;
  const drawPresent = !!drawTarget;

  // PD arrays / OTE in-direction (soft confluence — not required).
  const fvgInDir = !!(want && fvgs.some((f) => f.type === want && f.status !== 'filled'));
  const obInDir = !!(want && orderBlock.type === want && !orderBlock.mitigated);
  const inOteZone = want === 'bullish' ? (premiumDiscount.currentZone === 'discount' || ote.priceInOTE)
    : want === 'bearish' ? (premiumDiscount.currentZone === 'premium' || ote.priceInOTE) : false;
  const displacementAligned = !!want && displacement.direction === want;

  // 5M entry-timing confirmation — at least ONE actionable 5M trigger (no single
  // concept is individually required).
  const entryTrigger = sweepAligned || displacementAligned || reversalConfirmed || bosAligned || fvgInDir || obInDir || inOteZone;

  // Trade levels (market-fallback when no PD array — see computeSetup).
  if (want) setup = computeSetup({ dir, pair, currentPrice, atrPrice, fvgs, orderBlock, ote, liquidityMap, sweep, candles: entryTf });

  // ── HARD GATES — the ONLY rejecters ──────────────────────────────────────────
  const hardFails = [];
  if (!htfAligned) hardFails.push('Hard gate: Daily and 4H directional bias are not aligned.');
  if (htfAligned && !kz.inKillzone) hardFails.push('Hard gate: no active killzone/session.');
  if (htfAligned && !(sweepAligned || drawPresent)) hardFails.push('Hard gate: no liquidity sweep or clear draw on liquidity in direction.');
  if (htfAligned && !h1Transition.ready) hardFails.push(`Hard gate: hourly entry transition not ready — ${h1Transition.reason}`);
  if (htfAligned && !entryTrigger) hardFails.push('Hard gate: no 5M entry-timing trigger.');
  if (news.blocked) hardFails.push(`Hard gate: ${news.blockReason}`);
  if (htfAligned && want && (!setup || !setup.ok)) hardFails.push(`Hard gate: ${setup?.reason || 'no executable 5M entry/target.'}`);

  // ── SOFT CONFLUENCE — scoring only; never rejects ────────────────────────────
  const confluence = [];
  const missingConfluence = [];
  const track = (present, label) => { (present ? confluence : missingConfluence).push(label); };
  track(sweepAligned, 'liquidity sweep');
  track(displacementAligned, 'displacement');
  track(reversalConfirmed || bosAligned, 'MSS/BOS/CHoCH');
  track(fvgInDir, 'FVG');
  track(obInDir, 'order block');
  track(inOteZone, 'OTE / discount-premium');
  track(smt.smtDetected, 'SMT divergence');
  track(inducement.inducementSwept, 'inducement swept');
  track(powerOf3?.phase === 'Distribution', 'Power of 3 (distribution)');
  track(silverBulletWindow, 'Silver Bullet window');
  track(turtleSoup.turtleSoupDetected, 'Turtle Soup');
  track(judas.judasSwingDetected, 'Judas Swing');

  const labelCount = [powerOf3?.phase === 'Distribution', silverBulletWindow, turtleSoup.turtleSoupDetected, judas.judasSwingDetected].filter(Boolean).length;
  const confluenceScore = computeIctConfidence({
    htfAligned,
    killzoneQuality: kz.inKillzone ? kz.killzoneQuality : 0,
    sweepAligned, drawPresent, entryTrigger, hourlyTransition: h1Transition.ready,
    displacementAligned, mssOrChoch: reversalConfirmed || bosAligned,
    fvgInDir, obInDir, inOteZone, smt: smt.smtDetected,
    inducementSwept: inducement.inducementSwept, labels: labelCount,
    rr: setup?.ok ? setup.rr : null,
  });

  // Timing diagnostics remain visible but do not veto a valid current-price scalp.
  // The order decision is current direction plus executable SL/TP geometry.
  const displacementAgeBars = displacementAligned && Number.isInteger(displacement?.candleIndex)
    ? Math.max(0, entryTf.length - 1 - displacement.candleIndex)
    : null;
  const triggerAges = [
    sweepAligned ? 0 : null,
    reversalConfirmed ? 0 : null,
    bosAligned ? 0 : null,
    displacementAgeBars,
  ].filter(Number.isFinite);
  const triggerAgeBars = triggerAges.length ? Math.min(...triggerAges) : null;
  const freshImpulse = Number.isFinite(triggerAgeBars) && triggerAgeBars <= 1;

  const timing = gradeTiming({ pair, currentPrice, setup, atrPrice });
  const idealEntry = Number(setup?.idealEntry ?? setup?.entry);
  const entryDriftAtr = atrPrice && Number.isFinite(idealEntry)
    ? Math.abs(currentPrice - idealEntry) / atrPrice
    : 99;
  const targetPrice = Number(setup?.target1);
  const totalTargetMove = Number.isFinite(idealEntry) && Number.isFinite(targetPrice)
    ? Math.abs(targetPrice - idealEntry)
    : 0;
  const consumedMove = Number.isFinite(idealEntry)
    ? Math.max(0, dir === 'long' ? currentPrice - idealEntry : idealEntry - currentPrice)
    : 0;
  const rewardConsumedFraction = totalTargetMove > 0 ? consumedMove / totalTargetMove : 1;
  const zoneLowNow = Number(setup?.entryZoneLow);
  const zoneHighNow = Number(setup?.entryZoneHigh);
  const zoneTolerance = atrPrice ? atrPrice * 0.10 : 0;
  const priceInsideEntryZone = setup?.entrySource === 'MARKET' || (
    Number.isFinite(zoneLowNow) && Number.isFinite(zoneHighNow) &&
    currentPrice >= Math.min(zoneLowNow, zoneHighNow) - zoneTolerance &&
    currentPrice <= Math.max(zoneLowNow, zoneHighNow) + zoneTolerance
  );
  const executableRisk = setup?.ok ? Math.abs(currentPrice - setup.stopLoss) : 0;
  const executableReward = setup?.ok ? Math.abs(setup.target1 - currentPrice) : 0;
  const executableRRRaw = executableRisk > 0 ? executableReward / executableRisk : 0;
  // Compare at the same two-decimal precision presented to the user. This avoids
  // rejecting values such as 1.4999999998 while the dashboard correctly shows 1.50.
  const executableRR = Math.round((executableRRRaw + Number.EPSILON) * 100) / 100;
  const targetConfidence = computeIctTargetHitConfidence({
    confluenceScore,
    freshImpulse,
    triggerAgeBars,
    entryDriftAtr,
    rewardConsumedFraction,
    priceInsideEntryZone,
    actualRR: executableRR,
    minimumRR: configuredIctMinRR(),
    targetAdjusted: Boolean(setup?.targetAdjustedToMinRR),
    spreadPips: 0,
    maxSpreadPips: Number(process.env.ICT_MAX_SPREAD_PIPS || process.env.FOREX_MAX_SPREAD_PIPS || 3.5),
    minConfidence: ictExecConfig().minConfidence,
  });
  const confidence = targetConfidence.confidence;

  const minimumExecutableRR = Math.round((configuredIctMinRR() + Number.EPSILON) * 100) / 100;
  if (setup?.ok && executableRR < minimumExecutableRR) hardFails.push(`Hard gate: executable R:R ${executableRR.toFixed(2)} is below ${minimumExecutableRR.toFixed(2)}.`);

  // ── DECISION — target-hit confidence, not raw confluence, is authoritative ──
  const DISPLAY_MIN = ictExecConfig().minConfidence;
  if (hardFails.length === 0 && want && setup?.ok && confidence >= DISPLAY_MIN && targetConfidence.eligible) {
    signal = want === 'bullish' ? 'buy' : 'sell';
    setupType = classifyIctStrategy({
      silverBulletWindow,
      turtleSoup: turtleSoup.turtleSoupDetected,
      judasSwing: judas.judasSwingDetected,
      powerOf3Distribution: powerOf3?.phase === 'Distribution',
      sweepAligned, displacementAligned, reversalConfirmed, bosAligned,
      fvgInDir, obInDir, inOteZone,
      breakerConfirmed: Boolean(orderBlock?.failed || orderBlock?.breaker || orderBlock?.invalidated),
    });
  }

  rejectionReasons.push(...hardFails);
  if (signal === 'none' && hardFails.length === 0) {
    rejectionReasons.push(
      `Target-hit confidence below execution threshold: ${confidence} < ${DISPLAY_MIN}. ` +
      `Timing ${targetConfidence.timingScore}/100, geometry ${targetConfidence.geometryScore}/100, ` +
      `confluence ${targetConfidence.confluenceScore}/100.`
    );
  }
  void pendingSweepDir; // Minimum R:R is already constructed into setup.target1.

  // Silver Bullet detail object (spec shape).
  const silverBullet = {
    activeWindow: silverBulletWindow,
    direction: signal === 'buy' ? 'bullish' : signal === 'sell' ? 'bearish' : null,
    fvgEntry: silverBulletWindow && setup?.ok && setup.entrySource === 'FVG' ? setup.entry : null,
    stopLoss: silverBulletWindow && setup?.ok ? setup.stopLoss : null,
    liquidityTarget: silverBulletWindow && setup?.ok ? setup.target1 : null,
    confidence: silverBulletWindow && signal !== 'none' ? confidence : 0,
  };

  // Timing was calculated before qualification so stale/late entries cannot be promoted.

  const ictBias = htfAligned ? dailyTfBias : 'neutral';
  const ictNarrative = buildNarrative({ pair: instrumentMeta.displaySymbol, dir, bias, sweep, displacement, mss, choch, premiumDiscount, ote, kz, irlErl, signal, setupType });

  // ICT is fully independent — V3 is never consulted here. Any V3-vs-ICT
  // comparison is display-only and merged by the API route (see v3IctComparison.js).
  const v3Comparison = null;

  // Scan-log contract: emit a compact candidate summary and one separate line
  // for every rejection. Railway truncates long messages, so reasons must never
  // be hidden inside one oversized JSON or collapsed to only "5M=none".
  const scanRR = setup?.ok && Number.isFinite(Number(setup.rr)) ? Number(setup.rr).toFixed(2) : 'n/a';
  console.log(
    `[ICT] ${pair} mode=${ICT_MODE} autoTrade=${ictExecConfig().autoTradeEnabled} independentFromV3=true | ` +
    `dailyBias=${dailyTfBias} h4Bias=${h4TfBias} aligned=${htfAligned} | ` +
    `5M=${signal !== 'none' ? 'confirmed' : 'none'} signal=${signal} conf=${confidence} rr=${scanRR} ` +
    `killzone=${kz.inKillzone} liquidity=${sweepAligned || drawPresent} entryTrigger=${entryTrigger}` +
    `${news.blocked ? ' [NEWS-BLOCK]' : news.caution ? ' [news-caution]' : ''}`,
  );
  if (signal === 'none') {
    if (!rejectionReasons.length) {
      console.log(`[ICT_REJECT_REASON] pair=${pair} reason="unknown scanner rejection"`);
    }
    for (const reason of rejectionReasons) {
      console.log(`[ICT_REJECT_REASON] pair=${pair} reason=${JSON.stringify(String(reason))}`);
    }
  }

  return {
    pair,
    displaySymbol: instrumentMeta.displaySymbol,
    assetClass: instrumentMeta.assetClass,
    marketDataSource: instrumentMeta.sourceLabel,
    marketDataProxySymbol: instrumentMeta.sourceSymbol,
    executionEligible: instrumentMeta.executionEligible,
    pricePrecision: instrumentMeta.pricePrecision,
    timestamp, signalId, generatedAtMs,
    strategy: 'SCALP',
    tradeStyle: 'SCALP',
    tradeDuration: 'Scalp',
    timeframeEstimate: 'Scalp',
    scalpOnly: true,
    ictBias,
    timeframeBias: {
      d1: dailyTfBias,
      h4: h4TfBias,
      h1: h1TfBias,
      h1AnalysisOnly: true,
      d1H4Aligned: htfAligned,
      direction: analysisDirection,
    },
    ictNarrative,
    setupType,
    signal,
    entry: setup?.ok ? setup.entry : null,
    stopLoss: setup?.ok ? setup.stopLoss : null,
    target1: setup?.ok ? setup.target1 : null,
    target2: setup?.ok ? setup.target2 : null,
    rr: setup?.ok ? setup.rr : null,
    atrPips,
    riskModel: setup?.ok ? setup.riskModel ?? null : null,
    confidence,
    targetHitConfidence: confidence,
    confluenceScore,
    targetConfidence,
    h1Transition,
    freshImpulse,
    triggerAgeBars,
    idealEntry: setup?.ok ? setup.idealEntry ?? null : null,
    entryZoneLow: setup?.ok ? setup.entryZoneLow ?? null : null,
    entryZoneHigh: setup?.ok ? setup.entryZoneHigh ?? null : null,
    targetAdjustedToMinRR: Boolean(setup?.targetAdjustedToMinRR),
    conceptsDetected,
    rejectionReasons,
    // additive bundle for the dashboard
    concepts: {
      liquidityMap, sweep, displacement, mss, bos, choch, fvgs, orderBlock,
      inducement, premiumDiscount, ote, powerOf3, killzone: kz, macro,
      silverBullet, smt, turtleSoup, judas, irlErl, dailyBias: bias,
      htf: {
        dailyBias: dailyTfBias,
        h4Bias: h4TfBias,
        h1Bias: h1TfBias,
        h1AnalysisOnly: true,
        aligned: htfAligned,
        h1Transition,
      },
      news, candle,
      confluence, missingConfluence,
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
  const instrumentMeta = getIctInstrumentMeta(pair);
  return {
    pair,
    displaySymbol: instrumentMeta.displaySymbol,
    assetClass: instrumentMeta.assetClass,
    marketDataSource: instrumentMeta.sourceLabel,
    marketDataProxySymbol: instrumentMeta.sourceSymbol,
    executionEligible: instrumentMeta.executionEligible,
    pricePrecision: instrumentMeta.pricePrecision,
    timestamp, signalId: `${pair}:${generatedAtMs}`, generatedAtMs,
    ictBias: 'neutral',
    timeframeBias: {
      d1: 'neutral', h4: 'neutral', h1: 'neutral', h1AnalysisOnly: true,
      d1H4Aligned: false, direction: 'none',
    },
    ictNarrative: `${instrumentMeta.displaySymbol}: ${reason}`,
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
    const sets = await Promise.all(TF.map(([key, g, n]) => getIctCandles(
      pair,
      g,
      n,
      { client, includeIncomplete: key === 'h1' },
    ).catch(() => [])));
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

  const executionConfig = ictExecConfig();

  return {
    analyses,
    meta: {
      ictEngineMode: ICT_MODE,
      executionEnabled: isIctExecutionEnabled(),
      executionMinConfidence: executionConfig.minConfidence,
      executionMinRR: executionConfig.minRR,
      pairsAnalyzed: list.length,
      generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
      signals: analyses.filter((a) => a.signal !== 'none').length,
    },
  };
}


// June 23 soft-filter scoring
// These filters should influence confidence, not hard-reject otherwise valid trades.
export function applyJune23SoftFilterScoring(candidate = {}) {
  let confidenceAdjustment = 0;
  const softReasons = [];

  if (candidate.regimeAligned === true) {
    confidenceAdjustment += 1;
    softReasons.push("Regime aligned: +1 confidence");
  } else if (candidate.regimeAligned === false) {
    confidenceAdjustment -= 1;
    softReasons.push("Regime not aligned: -1 confidence");
  }

  if (candidate.liquidityIntentStrong === true) {
    confidenceAdjustment += 2;
    softReasons.push("Strong liquidity intent: +2 confidence");
  } else if (candidate.liquidityIntentStrong === false) {
    confidenceAdjustment -= 1;
    softReasons.push("Weak liquidity intent: -1 confidence");
  }

  if (candidate.calibrationPositive === true) {
    confidenceAdjustment += 1;
    softReasons.push("Positive calibration: +1 confidence");
  } else if (candidate.calibrationPositive === false) {
    confidenceAdjustment -= 1;
    softReasons.push("Negative calibration: -1 confidence");
  }

  if (candidate.smtDivergence === true) {
    confidenceAdjustment += 1;
    softReasons.push("SMT divergence present: +1 confidence");
  }

  if (candidate.sessionNarrativeAligned === true) {
    confidenceAdjustment += 1;
    softReasons.push("Session narrative aligned: +1 confidence");
  }

  const baseConfidence = Number(candidate.confidence ?? 0);
  const finalConfidence = Math.max(0, Math.min(100, baseConfidence + confidenceAdjustment));

  return {
    ...candidate,
    baseConfidence,
    confidence: finalConfidence,
    confidenceAdjustment,
    softReasons,
  };
}
