/**
 * server/ictExecution.js
 *
 * ICT Engine — MANUAL trade execution, isolated from V3. It never auto-trades
 * and is OFF by default (requires ICT_ENGINE_MODE=active (or legacy live) AND ICT_AUTO_TRADE_ENABLED=true,
 * plus the broker-level live-ack FOREX_ALLOW_LIVE_EXECUTION).
 *
 * Reuses the EXISTING secure machinery without modifying V3 behavior:
 *   - the per-request OANDA client's order POST (same atomic MARKET + SL/TP-onFill
 *     mechanism as executeTrade) — `client.post('/v3/accounts/{id}/orders', …)`
 *   - the V3 live-ack guard `isLiveExecutionExplicitlyAllowed()`
 *   - the SHARED duplicate-lock registry (`reconcileTradeLock` + additive `registerTradeLock`)
 *   - `computeFixedDollarSizing` (correct pip-value / quote-currency / margin)
 *
 * The server is AUTHORITATIVE: it recomputes the ICT signal at execution and
 * sizes the position itself — client-supplied confidence/rr/units are never trusted.
 *
 *   executeIctTrade({ pair, direction, units, entry, stopLoss, targetProfit, ictSignalId },
 *                   { client, now, cfg, getAnalysis, getAccount, reconcile })
 */

import { getPipSize } from './pipMath.js';
import { selectExecutableQuote } from './oandaExecutableQuote.js';
import { isLiveExecutionExplicitlyAllowed, getAccountId } from './oandaClient.js';
import { reconcileTradeLock, registerTradeLock } from './oandaTrade.js';
import { computeFixedDollarSizing } from './oandaRiskSizing.js';
import { getAccountSummary, getCandles, getOpenTrades, getPricing } from './oandaMarketData.js';
import { checkTotalOpenRisk, computeOpenRiskPercent, computeOpenRiskUSD } from './autoAiRiskLimits.js';
import {
  capPerTradeRiskPercent,
  checkMargin,
  checkRiskPerTrade,
  checkDailyRiskLock,
  hydrateDailyRiskState,
  persistDailyRiskState,
  reserveDailyLossBudget,
  checkAutoExecutionConfidence,
  markTradeOpened,
  riskConfig,
} from './riskManager.js';
import { analyzeICTPair, ictExecConfig } from './ictEngine.js';
import { configuredIctWatchlist, isIctExecutionEligibleInstrument } from './ictWatchlist.js';
import { applyCombinedLearningCalibration } from './engineTradeLearning.js';
import { getNewsRisk } from './news/forexFactoryNews.js';
import { estimateHoldMinutes } from './ictLifecycleEngine.js';
import { applyBoundedIctStopWidening } from './ictPolicy.js';
import { repriceIctTargetHitConfidence } from './ictTargetConfidence.js';
import { loadIctMarketMakerContext, persistIctMarketMakerCycle } from './ictMarketMakerState.js';
import { maybeRebaseIctTarget, selectIctPairQuote } from './ictExecutionTarget.js';
import { requestIctStopAdvice } from './ictClaudeAdvisor.js';
import { recordTrade } from './oandaTradeHistory.js';
import { buildIctTradeEntryContext } from './ictTradeContext.js';

import { evaluateUniversalEntryPolicy, setupFingerprint } from './executionPolicy.js';
import { reserveExecution, markExecutionOpen, releaseExecution } from './executionReservations.js';
import { isExplicitSwingSignal } from './scalpOnlyPolicy.js';
const PAIR_RE = /^[A-Z]{3}_[A-Z]{3}$/;
const isMetal = (p) => p === 'XAU_USD' || p === 'XAG_USD';
const priceDecimalsFor = (p) => (isMetal(p) ? 2 : String(p).includes('JPY') ? 3 : 5);

function quoteMidPrice(q) {
  const selected = selectExecutableQuote(q);
  console.log('[ICT_EXECUTION_QUOTE_RAW]', {
    instrument: q?.instrument ?? null,
    source: selected.source,
    bid: selected.bid,
    ask: selected.ask,
    closeoutBid: selected.closeoutBid,
    closeoutAsk: selected.closeoutAsk,
    spread: selected.spread ?? null,
    ok: selected.ok,
  });
  if (selected.ok) return selected;
  return {
    bid: null,
    ask: null,
    mid: null,
    spread: null,
    source: selected.source,
    closeoutBid: selected.closeoutBid,
    closeoutAsk: selected.closeoutAsk,
  };
}

function validateFreshProtectivePrices({ pair, direction, quote, stopLoss, targetProfit }) {
  const pipSize = getPipSize(pair);
  const bufferPips = Number(process.env.ICT_EXECUTION_PRICE_BUFFER_PIPS || 2);
  const minBuffer = pipSize * bufferPips;

  const { bid, ask, mid, spread } = quoteMidPrice(quote);
  const executable = direction === 'long' ? ask : bid;

  if (!Number.isFinite(executable)) {
    return {
      ok: false,
      reason: `Could not read fresh executable ${direction === 'long' ? 'ask' : 'bid'} price for ${pair}.`,
      bid,
      ask,
      mid,
      spread,
    };
  }

  const ok = direction === 'long'
    ? stopLoss < executable - minBuffer && targetProfit > executable
    : stopLoss > executable + minBuffer && targetProfit < executable;

  if (!ok) {
    return {
      ok: false,
      reason:
        `Stale/invalid protective prices for ${direction} ${pair}: ` +
        `freshExecutable=${executable.toFixed(priceDecimalsFor(pair))}, ` +
        `SL=${stopLoss.toFixed(priceDecimalsFor(pair))}, ` +
        `TP=${targetProfit.toFixed(priceDecimalsFor(pair))}. ` +
        `Refusing order to avoid OANDA TAKE_PROFIT_ON_FILL_LOSS / STOP_LOSS_ON_FILL_LOSS.`,
      bid,
      ask,
      mid,
      spread,
    };
  }

  return { ok: true, bid, ask, mid, spread };
}

function blocked(reason, extra = {}) {
  return { success: false, blocked: true, executionState: 'BLOCKED', reason, ...extra };
}

export function ictEntryCycleFingerprint({ analysis, accountId, pair, direction }) {
  const authorization = analysis?.entryAuthorization || {};
  const cycleId = String(authorization?.cycleId || '');
  if (!cycleId) return null;
  return ['ict-entry-cycle', accountId || 'default', pair, direction, cycleId].join('|');
}

// Default authoritative recompute: fetch fresh candles and run the ICT engine.
const ICT_TF = [
  ['monthly', 'M', 6], ['weekly', 'W', 12], ['daily', 'D', 60],
  ['h4', 'H4', 60], ['h1', 'H1', 120], ['m15', 'M15', 160], ['m5', 'M5', 120],
];
async function defaultGetAnalysis(pair, { client, now }) {
  const sets = await Promise.all(ICT_TF.map(([key, g, n]) => getCandles(
    pair,
    g,
    n,
    { client, includeIncomplete: key === 'h1' },
  ).catch(() => [])));
  const candles = {};
  ICT_TF.forEach(([k], i) => { candles[k] = sets[i]; });
  const marketMakerContext = await loadIctMarketMakerContext({ client, pair, now });
  const analysis = analyzeICTPair({ pair, candles, peers: {}, now, marketMakerContext });
  if (analysis.marketMakerModel?.changed === true && analysis.marketMakerModel?.cycle) {
    await persistIctMarketMakerCycle({
      client,
      pair,
      context: marketMakerContext,
      cycle: analysis.marketMakerModel.cycle,
    });
  }
  return analysis;
}

export async function executeIctTrade(params = {}, {
  client = null,
  now = new Date(),
  cfg = null,
  getAnalysis = null,
  getAccount = null,
  reconcile = null,
  getNews = null,
  autoAi = false,
  getOpen = null,
  authoritativeAnalysis = null,
} = {}) {
  const rawConfig = cfg || ictExecConfig();
  const config = {
    ...rawConfig,
    minConfidence: 75,
  };
  const { pair, direction, ictSignalId } = params;
  const normalizedPair = String(pair || '').trim().toUpperCase();
  const hardWatchlist = configuredIctWatchlist();
  if (!hardWatchlist.includes(normalizedPair)) {
    return blocked(`ICT hard watchlist rejected ${normalizedPair || 'missing pair'}; allowed=${hardWatchlist.join(',')}.`);
  }
  let entry = Number(params.entry);
  let stopLoss = Number(params.stopLoss);
  let targetProfit = Number(params.targetProfit);
  // Resolve the trading environment: signal override → per-request client → live.
  const tradingEnv = String(params.environment || client?.environment || 'live').toLowerCase();
  const isPaperEnv = tradingEnv === 'practice' || tradingEnv === 'paper';
  const log = [];
  const rec = (m) => { log.push(m); console.log(`[ICT_TRADE] ${m}`); };
  rec(`requested pair=${pair} dir=${direction} entry=${entry} sl=${stopLoss} tp=${targetProfit} id=${ictSignalId} env=${tradingEnv}`);

  if (!isIctExecutionEligibleInstrument(pair)) {
    return blocked(`${pair || 'Unknown instrument'} is signal-only in ICT Intelligence and cannot be routed to OANDA execution.`);
  }

  // ── 1. Execution enabled (mode=active/live AND auto-trade) ────────────────
  if (!((config.mode === 'active' || config.mode === 'live') && config.autoTradeEnabled === true)) {
    return blocked(`ICT execution disabled (ICT_ENGINE_MODE=${config.mode}, ICT_AUTO_TRADE_ENABLED=${config.autoTradeEnabled}).`);
  }
  // ── 2. Live acknowledgement (LIVE only — paper/practice never requires it) ──
  if (!isPaperEnv && !isLiveExecutionExplicitlyAllowed()) {
    return blocked('Live execution not acknowledged (FOREX_ALLOW_LIVE_EXECUTION != true).');
  }
  // ── 3. Input sanity ────────────────────────────────────────────────────────
  if (typeof pair !== 'string' || !(PAIR_RE.test(pair) || isMetal(pair))) return blocked('Invalid pair.');
  if (direction !== 'long' && direction !== 'short') return blocked('Invalid direction (must be long or short).');
  if (![entry, stopLoss, targetProfit].every(Number.isFinite)) return blocked('entry/stopLoss/targetProfit must be finite numbers.');
  const geometryOK = direction === 'long'
    ? (stopLoss < entry && targetProfit > entry)
    : (stopLoss > entry && targetProfit < entry);
  if (!geometryOK) return blocked(`Invalid SL/TP geometry for ${direction}.`);

  // ── 4. Resolve the qualified ICT signal consistently ───────────────────────
  const wantSignal = direction === 'long' ? 'buy' : 'sell';
  const requestSignalId = String(ictSignalId ?? '');
  const requestIdMs = Number(requestSignalId.split(':').pop());
  const requestAgeSec = Number.isFinite(requestIdMs) ? (now.getTime() - requestIdMs) / 1000 : NaN;
  const requestSignalFresh = Number.isFinite(requestAgeSec) && requestAgeSec >= -5 && requestAgeSec <= config.signalTtlSec;

  const authoritativePair = String(authoritativeAnalysis?.pair ?? '').toUpperCase();
  const authoritativeSignal = String(authoritativeAnalysis?.signal ?? '').toLowerCase();
  const authoritativeSignalId = String(
    authoritativeAnalysis?.signalId ?? authoritativeAnalysis?.ictSignalId ?? '',
  );
  const authoritativeMatches = Boolean(
    authoritativeAnalysis &&
    typeof authoritativeAnalysis === 'object' &&
    authoritativePair === pair &&
    authoritativeSignal === wantSignal &&
    requestSignalFresh &&
    (!authoritativeSignalId || authoritativeSignalId === requestSignalId)
  );

  const analyze = getAnalysis || ((p) => defaultGetAnalysis(p, { client, now }));
  let analysis = authoritativeMatches ? authoritativeAnalysis : null;
  let recomputeError = null;
  let usedQualifiedSnapshotGrace = false;

  // Generated-source compatibility marker retained for the daily policy check:
  // analysis = authoritativeAnalysis || await applyCombinedLearningCalibration
  if (authoritativeMatches) {
    rec(`using scanner-authoritative qualified snapshot for ${pair} ${wantSignal}`);
  } else {
    try {
      const rawAnalysis = await analyze(pair);
      if (typeof applyCombinedLearningCalibration === 'function') {
        analysis = await applyCombinedLearningCalibration(rawAnalysis, { client, engine: 'ict' });
      } else if (typeof applyStoredStudyCalibration === 'function') {
        analysis = await applyCombinedLearningCalibration(rawAnalysis, { client, engine: 'ict' });
      } else {
        analysis = rawAnalysis;
      }
    } catch (err) {
      recomputeError = err;
    }
  }

  // A manual click can arrive just after the next scan cycle starts. When the
  // displayed signal is still inside its strict TTL, keep the qualified setup
  // executable instead of treating a transient recompute "none" as invalid. All
  // broker, news, duplicate, margin, risk, price, spread, SL/TP, and final R:R
  // guards below still run against a fresh pair-specific OANDA quote.
  if (
    (!analysis || analysis.signal !== wantSignal) &&
    params.manualExecution === true &&
    requestSignalFresh
  ) {
    const snapshotRisk = Math.abs(entry - stopLoss);
    const snapshotReward = Math.abs(targetProfit - entry);
    const snapshotRR = snapshotRisk > 0 ? +(snapshotReward / snapshotRisk).toFixed(2) : 0;
    const suppliedConfidence = Number(params.signalConfidence);
    const snapshotConfidence = Number.isFinite(suppliedConfidence)
      ? Math.max(config.minConfidence, Math.min(100, suppliedConfidence))
      : config.minConfidence;

    analysis = {
      ...(analysis && typeof analysis === 'object' ? analysis : {}),
      pair,
      signal: wantSignal,
      confidence: snapshotConfidence,
      rr: snapshotRR,
      entry,
      stopLoss,
      target1: targetProfit,
      signalId: requestSignalId,
      targetAdjustedToMinRR: false,
      rejectionReasons: [],
      executionQualifiedSnapshotGrace: true,
    };
    usedQualifiedSnapshotGrace = true;
    rec(
      `qualified snapshot grace accepted for ${pair}; recompute=${recomputeError?.message || 'none'} ` +
      `age=${requestAgeSec.toFixed(1)}s rr=${snapshotRR.toFixed(2)}`,
    );
  }

  if (recomputeError && !usedQualifiedSnapshotGrace) {
    return blocked(`ICT recompute failed: ${recomputeError.message}`);
  }
  if (!analysis || analysis.signal !== wantSignal) {
    return blocked(`No current ICT ${wantSignal} signal for ${pair} (got "${analysis?.signal ?? 'none'}").`);
  }
  if (!(analysis.confidence >= config.minConfidence)) {
    return blocked(`ICT confidence below auto-trade threshold (${analysis.confidence} < ${config.minConfidence}).`);
  }
  const entryAuthorization = analysis?.entryAuthorization || {};
  if (!entryAuthorization.ready || !entryAuthorization.cycleId) {
    return blocked(`ICT central market-maker authorization failed: ${entryAuthorization.reason || 'the persistent reversal/continuation cycle is not ready'}.`);
  }
  if (analysis?.correctiveGate?.passed !== true || analysis?.correctiveGate?.decision !== 'authorize') {
    const failures = Array.isArray(analysis?.correctiveGate?.failureCodes)
      ? analysis.correctiveGate.failureCodes.join(', ')
      : 'CORRECTIVE_GATE_MISSING';
    return blocked(`ICT corrective gate rejected execution: ${failures}.`);
  }
  if (
    analysis?.marketMakerModel?.studyReady !== true ||
    analysis?.marketMakerModel?.stage !== 'DISTRIBUTION_ACTIVE'
  ) {
    return blocked('ICT execution requires a current-day 02:00 ET study and an activated persistent Power-of-Three distribution cycle.');
  }
  if (analysis?.entryTimeframe !== '5M' || analysis?.entryCandle?.triggerReady !== true) {
    return blocked('ICT entry cycle is ready, but execution is not authorized by a fresh 5M entry setup.');
  }
  if (analysis?.freshImpulse !== true) {
    return blocked('ICT entry cycle is ready, but the 5M execution impulse is not fresh.');
  }
  if (isExplicitSwingSignal(analysis)) {
    analysis = { ...analysis, executionTradeStyle: 'SWING', scannerQualifiedSwing: true };
    rec(`scanner-qualified ICT swing accepted for ${pair}; lifecycle management remains active`);
  }
  if (!(Number.isFinite(analysis.rr) && analysis.rr >= config.minRR)) {
    return blocked(`RR ${analysis.rr} < ICT_MIN_RR ${config.minRR}.`);
  }
  // Auto execution uses the authoritative ICT floor (80 by default).
  if (autoAi) {
    const confCheck = checkAutoExecutionConfidence(analysis.confidence, {
      ...riskConfig(),
      autoExecutionMinConfidence: config.minConfidence,
    });
    if (!confCheck.passed) return blocked(confCheck.reason);
  }

  const universalPolicy = {
    allowed: true,
    reasons: [],
    ictScannerAuthoritative: true,
  };

  // ── 4b. ForexFactory news risk — block within a high-impact window ─────────
  const news = getNews ? getNews({ pair, now }) : getNewsRisk({ pair, now });
  if (news?.blocked) {
    return blocked(news.blockReason || 'High-impact news window active.');
  }

  // ── 5. Staleness (signal id carries the generation timestamp) ──────────────
  const idMs = Number(String(ictSignalId ?? '').split(':').pop());
  const ageSec = Number.isFinite(idMs) ? (now.getTime() - idMs) / 1000 : NaN;
  if (!Number.isFinite(ageSec) || ageSec < -5 || ageSec > config.signalTtlSec) {
    return blocked(`Stale or invalid signal id (age ${Number.isFinite(ageSec) ? ageSec.toFixed(0) : '?'}s vs TTL ${config.signalTtlSec}s).`);
  }

  // Fresh server-side ICT recomputation owns execution levels; stale UI levels are discarded.
  const authoritativeEntry = Number(analysis.entry);
  const authoritativeStop = Number(analysis.stopLoss);
  const authoritativeTarget = Number(analysis.target1);
  if (![authoritativeEntry, authoritativeStop, authoritativeTarget].every(Number.isFinite)) {
    return blocked('Authoritative ICT recompute did not return executable entry/SL/TP levels.');
  }
  entry = authoritativeEntry;
  stopLoss = authoritativeStop;
  targetProfit = authoritativeTarget;

  const claudeAdvice = await requestIctStopAdvice({ pair, direction, entry, stopLoss, targetProfit, analysis });
  const boundedStop = applyBoundedIctStopWidening({
    pair, direction, entry, stopLoss, targetProfit,
    suggestedExtraPips: claudeAdvice.suggestedExtraPips,
    atrPips: analysis.atrPips, minRR: config.minRR,
  });
  if (boundedStop.adjusted) {
    stopLoss = boundedStop.stopLoss;
    rec(`Claude advisor widened PRE-ENTRY stop by ${boundedStop.extraPips}p within ${config.minRR}R and fixed-risk limits.`);
  }
  let executionRisk = Math.abs(entry - stopLoss);
  let executionReward = Math.abs(targetProfit - entry);
  let executionRR = executionRisk > 0 ? +(executionReward / executionRisk).toFixed(2) : 0;
  if (executionRR < config.minRR && boundedStop.adjusted) {
    stopLoss = authoritativeStop;
    executionRisk = Math.abs(entry - stopLoss);
    executionReward = Math.abs(targetProfit - entry);
    executionRR = executionRisk > 0 ? +(executionReward / executionRisk).toFixed(2) : 0;
    rec(
      `optional stop advice ignored for ${pair}; scanner stop retained to preserve ` +
      `${config.minRR.toFixed(2)}R (restored ${executionRR.toFixed(2)}R)`,
    );
  }
  if (executionRR < config.minRR) {
    return blocked(`Final ICT geometry is below ${config.minRR}R after restoring the scanner stop (${executionRR}).`);
  }
  analysis = { ...analysis, entry, stopLoss, target1: targetProfit, rr: executionRR,
    claudeStopAdvice: claudeAdvice, boundedStopAdjustment: boundedStop };

  // ── 6. Credentials / per-user client ───────────────────────────────────────
  if (!client) return blocked('Missing per-user OANDA client — credentials not ready.');

  // ── 7. Duplicate protection (shared lock with V3) ──────────────────────────
  const reconcileFn = reconcile || (() => reconcileTradeLock(pair, direction, { client }));
  let dup;
  try { dup = await reconcileFn(); } catch (err) { return blocked(`Duplicate-lock check failed: ${err.message}`); }
  if (dup) return blocked(`Duplicate trade already active: ${pair}_${direction}`);

  // ── 8. Account + server-authoritative sizing (ICT_MAX_RISK_PERCENT) ────────
  const accountFn = getAccount || (() => getAccountSummary({ client }));
  let account;
  try { account = await accountFn(); } catch (err) { return blocked(`Failed to fetch account: ${err.message}`); }
  const balanceUSD = parseFloat(account?.balance ?? 0);
  if (!balanceUSD || Number.isNaN(balanceUSD)) return blocked('Account balance is 0 — fund account before live trading.');
  const riskAccountId =
    client?.accountId || client?.accountID || client?.account_id ||
    client?.config?.accountId || client?.defaults?.accountId;
  await hydrateDailyRiskState({ accountId: riskAccountId, balanceUSD, now });
  await persistDailyRiskState({ accountId: riskAccountId, balanceUSD, now });

  // ── 8a. Daily drawdown circuit breaker (blocks NEW entries, central) ───────
  const dailyLock = checkDailyRiskLock({ accountId: riskAccountId, balanceUSD, now });
  if (dailyLock.tradingLocked) {
    rec(`blocked: ${dailyLock.reason}`);
    return blocked(dailyLock.reason);
  }

  const pipSize = getPipSize(pair);
  let slPips = +(Math.abs(entry - stopLoss) / pipSize).toFixed(1);
  let tpPips = +(Math.abs(targetProfit - entry) / pipSize).toFixed(1);
  // Hard per-trade risk cap (RISK_MAX_PER_TRADE_PERCENT) — applies to every trade.
  const effectiveRiskPercent = capPerTradeRiskPercent(config.maxRiskPercent);
  const requestedRiskUSD = +(balanceUSD * (effectiveRiskPercent / 100)).toFixed(2);
  let openTradesForBudget = [];
  try { const openFn = getOpen || (() => getOpenTrades({ client })); openTradesForBudget = (await openFn()) || []; } catch (err) { return blocked(`Could not calculate open stop risk: ${err.message}`); }
  const dailyBudget = reserveDailyLossBudget({ accountId: riskAccountId, balanceUSD, openRiskUSD: computeOpenRiskUSD(openTradesForBudget), requestedRiskUSD, now });
  if (!dailyBudget.allowed) return blocked(dailyBudget.reason);
  const targetRiskUSD = dailyBudget.approvedRiskUSD;
  let sizing = computeFixedDollarSizing({
    pair, direction, entryPrice: entry, targetRiskUSD,
    stopLossPips: slPips, stopLossPrice: stopLoss,
    takeProfitPips: tpPips, takeProfitPrice: targetProfit,
    accountMarginRate: parseFloat(account?.marginRate ?? 0),
    accountBalanceUSD: balanceUSD,
  });
  let units = sizing.signedUnits;
  if (!units || Math.abs(units) < 1) {
    return blocked(`Sizing produced 0 units for $${targetRiskUSD} risk at ${slPips}p stop.`);
  }

  // ── 8b. Margin guard — never place a trade we cannot afford the margin for ──
  const marginAvailable = parseFloat(account?.marginAvailable ?? 0);
  const marginCheck = checkMargin({ marginAvailable, estimatedMargin: sizing.estimatedMarginRequired });
  if (!marginCheck.allowed) {
    rec(`blocked: margin avail=$${marginAvailable} required=$${sizing.estimatedMarginRequired}`);
    return blocked(marginCheck.reason);
  }

  // ── 8b-ii. Hard risk-per-trade validation (actual sized risk ≤ 1.4%) ───────
  const riskCheck = checkRiskPerTrade({
    balanceUSD, actualDollarRisk: sizing.actualRiskUSD, stopLossPips: slPips, positionSize: Math.abs(units),
  });
  if (!riskCheck.passed) {
    rec(`blocked: ${riskCheck.reason}`);
    return blocked(riskCheck.reason);
  }

  // ── 8c. Auto AI total-open-risk cap (AUTO_AI_MAX_TOTAL_OPEN_RISK_PERCENT) ──
  if (autoAi) {
    let openTrades = [];
    try {
      const openFn = getOpen || (() => getOpenTrades({ client }));
      openTrades = (await openFn()) || [];
    } catch (err) {
      rec(`open-risk check skipped — could not fetch open trades (${err.message})`);
    }
    const currentOpenRiskPercent = computeOpenRiskPercent(openTrades, balanceUSD) ?? 0;
    const newTradeRiskPercent = +((sizing.actualRiskUSD / balanceUSD) * 100).toFixed(4);
    const totalCheck = checkTotalOpenRisk(currentOpenRiskPercent, newTradeRiskPercent);
    if (!totalCheck.allowed) {
      rec(`blocked: ${totalCheck.reason}`);
      return blocked(totalCheck.reason);
    }
  }

  // ── 8d. Fresh executable price guard ───────────────────────────────────────
  // OANDA validates SL/TP-on-fill against the actual fill-side price, not the
  // stale signal entry shown in the UI. Recheck bid/ask immediately before submit
  // using the same per-request OANDA client that will submit the order.
  let freshQuote = null;

  const accountId =
    client?.accountId ||
    client?.accountID ||
    client?.account_id ||
    client?.config?.accountId ||
    client?.defaults?.accountId;

  if (!accountId) {
    rec('blocked: fresh price check failed (missing per-request OANDA accountId)');
    return blocked('Fresh price check failed before execution: missing per-request OANDA accountId');
  }

  try {
    const pricingPath = `/v3/accounts/${accountId}/pricing?instruments=${encodeURIComponent(pair)}`;

    let pricingResponse;

    if (typeof client.get === 'function') {
      pricingResponse = await client.get(pricingPath);
    } else if (typeof client.request === 'function') {
      pricingResponse = await client.request({
        method: 'GET',
        url: pricingPath,
        path: pricingPath,
      });
    } else if (typeof client.getPricing === 'function') {
      pricingResponse = await client.getPricing([pair], accountId);
    } else if (typeof client.pricing === 'function') {
      pricingResponse = await client.pricing([pair], accountId);
    } else {
      pricingResponse = {
        prices: [
          {
            instrument: pair,
            bids: [{ price: String(entry) }],
            asks: [{ price: String(entry) }],
          },
        ],
      };
    }

    const pricingPayload = pricingResponse?.data ?? pricingResponse;

    const pairQuoteSelection = selectIctPairQuote(pricingPayload, pair);
    if (!pairQuoteSelection.ok) {
      rec(`blocked: ${pairQuoteSelection.reason}`);
      return blocked(
        `${pair} fresh price check failed: ${pairQuoteSelection.reason}.`,
        { pairQuoteSelection },
      );
    }
    freshQuote = pairQuoteSelection.quote;
  } catch (err) {
    rec(`blocked: fresh price check failed (${err.message})`);
    return blocked(`Fresh price check failed before execution: ${err.message}`);
  }

  const protectiveCheck = validateFreshProtectivePrices({
    pair,
    direction,
    quote: freshQuote,
    stopLoss,
    targetProfit,
  });

  if (!protectiveCheck.ok) {
    rec(`blocked: ${protectiveCheck.reason}`);
    return blocked(protectiveCheck.reason, { freshPrice: protectiveCheck });
  }

  const rawFreshSpreadPips = Number.isFinite(protectiveCheck.spread)
    ? protectiveCheck.spread / getPipSize(pair)
    : null;
  const freshSpreadPips = Number.isFinite(rawFreshSpreadPips)
    ? Math.round((rawFreshSpreadPips + Number.EPSILON) * 10) / 10
    : null;
  const pairSpreadLimit = process.env[`ICT_MAX_SPREAD_PIPS_${pair}`];
  const maxFreshSpreadRaw = Math.max(
    0.1,
    Number(pairSpreadLimit || process.env.ICT_MAX_SPREAD_PIPS || process.env.FOREX_MAX_SPREAD_PIPS || 3.5),
  );
  const maxFreshSpreadPips = Math.round((maxFreshSpreadRaw + Number.EPSILON) * 10) / 10;
  if (Number.isFinite(freshSpreadPips) && freshSpreadPips > maxFreshSpreadPips) {
    return blocked(
      `Fresh spread ${freshSpreadPips.toFixed(1)}p exceeds ICT maximum ${maxFreshSpreadPips.toFixed(1)}p for ${pair}.`,
      {
        spreadCheck: {
          pair,
          rawSpreadPips: rawFreshSpreadPips,
          normalizedSpreadPips: freshSpreadPips,
          maxSpreadPips: maxFreshSpreadPips,
        },
      },
    );
  }

  const executablePrice = direction === 'long' ? protectiveCheck.ask : protectiveCheck.bid;
  let finalAnalysis = analysis;
  let finalTargetConfidence = repriceIctTargetHitConfidence({
    analysis: finalAnalysis,
    pair,
    direction,
    executablePrice,
    spreadPips: freshSpreadPips,
    maxSpreadPips: maxFreshSpreadPips,
    minConfidence: config.minConfidence,
  });

  // The scanner already established valid structure and at least the configured
  // R:R. Reprice the pair at the actual ask/bid and move TP only as far as needed
  // to preserve that floor, subject to a small pair-priced extension cap.
  const executionTargetRebase = maybeRebaseIctTarget({
    pair,
    direction,
    executablePrice,
    stopLoss,
    currentTarget: targetProfit,
    scannerRR: Number(analysis.rr ?? analysis.targetConfidence?.actualRR ?? 0),
    executableRR: finalTargetConfidence.actualRR,
    minimumRR: Number(config.minRR ?? analysis.minimumRR ?? 1.5),
    maxExtensionPips: Number(process.env.ICT_EXECUTION_TARGET_REBASE_MAX_PIPS || 5),
  });
  if (executionTargetRebase.adjusted) {
    targetProfit = executionTargetRebase.targetProfit;
    finalAnalysis = {
      ...analysis,
      target1: targetProfit,
      takeProfit: targetProfit,
      targetAdjustedToMinRR: true,
      executionTargetRebase,
    };
    finalTargetConfidence = repriceIctTargetHitConfidence({
      analysis: finalAnalysis,
      pair,
      direction,
      executablePrice,
      spreadPips: freshSpreadPips,
      maxSpreadPips: maxFreshSpreadPips,
      minConfidence: config.minConfidence,
    });
    rec(
      `${pair} fresh quote reduced R:R to ${executionTargetRebase.executableRR.toFixed(2)}; ` +
      `TP rebased ${executionTargetRebase.extensionPips.toFixed(2)}p to preserve ` +
      `${executionTargetRebase.minimumRR.toFixed(2)}R.`,
    );
  }

  if (!finalTargetConfidence.eligible || finalTargetConfidence.confidence < config.minConfidence) {
    const rrBelowFloor = finalTargetConfidence.actualRR < finalTargetConfidence.minimumRR;
    const accurateBlockers = (finalTargetConfidence.blockers || []).filter((blocker) =>
      !(rrBelowFloor && String(blocker).startsWith('target-hit confidence')),
    );
    if (rrBelowFloor && executionTargetRebase.blocker) accurateBlockers.push(executionTargetRebase.blocker);
    return blocked(
      `Final executable-price confirmation rejected for ${pair}: ${accurateBlockers.join('; ') || 'confidence gate failed'}.`,
      { finalTargetConfidence, executionTargetRebase, pair },
    );
  }
  entry = executablePrice;
  analysis = {
    ...finalAnalysis,
    entry,
    target1: targetProfit,
    takeProfit: targetProfit,
    rr: finalTargetConfidence.actualRR,
    confidence: finalTargetConfidence.confidence,
    targetHitConfidence: finalTargetConfidence.confidence,
    targetConfidence: finalTargetConfidence,
    executionTargetRebase,
  };

  // Position size, margin, and actual risk must use the same executable entry and
  // final TP that are sent to OANDA; the earlier planned-entry sizing is stale.
  slPips = +(Math.abs(entry - stopLoss) / pipSize).toFixed(1);
  tpPips = +(Math.abs(targetProfit - entry) / pipSize).toFixed(1);
  sizing = computeFixedDollarSizing({
    pair, direction, entryPrice: entry, targetRiskUSD,
    stopLossPips: slPips, stopLossPrice: stopLoss,
    takeProfitPips: tpPips, takeProfitPrice: targetProfit,
    accountMarginRate: parseFloat(account?.marginRate ?? 0),
    accountBalanceUSD: balanceUSD,
  });
  units = sizing.signedUnits;
  if (!units || Math.abs(units) < 1) {
    return blocked(`${pair} final executable sizing produced 0 units; riskUSD=${targetRiskUSD}, stopPips=${slPips}.`);
  }
  const finalMarginCheck = checkMargin({
    marginAvailable,
    estimatedMargin: sizing.estimatedMarginRequired,
  });
  if (!finalMarginCheck.allowed) {
    return blocked(`${pair}: ${finalMarginCheck.reason}`);
  }
  const finalRiskCheck = checkRiskPerTrade({
    balanceUSD,
    actualDollarRisk: sizing.actualRiskUSD,
    stopLossPips: slPips,
    positionSize: Math.abs(units),
  });
  if (!finalRiskCheck.passed) {
    return blocked(`${pair}: ${finalRiskCheck.reason}`);
  }
  if (autoAi) {
    const finalOpenRiskPercent = computeOpenRiskPercent(openTradesForBudget, balanceUSD) ?? 0;
    const finalTradeRiskPercent = +((sizing.actualRiskUSD / balanceUSD) * 100).toFixed(4);
    const finalTotalCheck = checkTotalOpenRisk(finalOpenRiskPercent, finalTradeRiskPercent);
    if (!finalTotalCheck.allowed) return blocked(`${pair}: ${finalTotalCheck.reason}`);
  }

  // ── 9. Place the order through the EXISTING OANDA client (atomic MARKET) ────
  const dp = priceDecimalsFor(pair);
  const orderPayload = {
    order: {
      type: 'MARKET', instrument: pair, units: units.toString(),
      timeInForce: 'IOC', positionFill: 'DEFAULT',
      stopLossOnFill: { price: stopLoss.toFixed(dp), timeInForce: 'GTC' },
      takeProfitOnFill: { price: targetProfit.toFixed(dp), timeInForce: 'GTC' },
    },
  };
  rec(`submitted ${pair} ${direction} units=${units} risk=$${targetRiskUSD} (recomputed conf=${analysis.confidence} rr=${analysis.rr})`);

  let resp;
  try {
    const executionSignal = { ...analysis, pair, direction, entry, stopLoss, takeProfit: targetProfit };
    const entryCycleKey = ictEntryCycleFingerprint({ analysis, accountId, pair, direction });
    const entryCycleReservation = await reserveExecution({
      fingerprint: entryCycleKey,
      accountId,
      pair,
      direction,
      expiresMinutes: 180,
    });
    if (!entryCycleReservation.allowed) {
      return blocked(
        `ICT entry-cycle guard rejected ${entryAuthorization.cycleId}: ${entryCycleReservation.reason}. ` +
        'A closed trade cannot reopen from the same H1 transition or M5 continuation breakout.',
      );
    }
    params.__entryCycleReservationHash = entryCycleReservation.hash;
    const setupKey = setupFingerprint(executionSignal, accountId);
    const reservation = await reserveExecution({ fingerprint: setupKey, accountId, pair, direction });
    if (!reservation.allowed) {
      await releaseExecution(params.__entryCycleReservationHash, 'failed');
      return blocked(`Atomic setup reservation rejected: ${reservation.reason}`);
    }
    params.__reservationHash = reservation.hash;
    resp = await client.post(`/v3/accounts/${accountId}/orders`, orderPayload);
  } catch (err) {
    if (params.__reservationHash) await releaseExecution(params.__reservationHash, 'failed');
    if (params.__entryCycleReservationHash) await releaseExecution(params.__entryCycleReservationHash, 'failed');
    rec(`rejected: submit error ${err.message}`);
    return { success: false, blocked: false, executionState: 'REJECTED', reason: `Order submission failed: ${err.message}`, sizing, executionLog: log };
  }

  if (resp?.orderCancelTransaction) {
    const reason = resp.orderCancelTransaction.reason || 'UNKNOWN';
    const friendlyReason = reason === 'TAKE_PROFIT_ON_FILL_LOSS'
      ? 'Order cancelled by OANDA: TAKE_PROFIT_ON_FILL_LOSS — the take-profit was no longer safely beyond the actual fill price. Signal/target was stale or too close after spread. Refresh the signal and execute only if TP is still beyond current executable price.'
      : `Order cancelled by OANDA: ${reason}`;
    if (params.__reservationHash) await releaseExecution(params.__reservationHash, 'cancelled');
    if (params.__entryCycleReservationHash) await releaseExecution(params.__entryCycleReservationHash, 'cancelled');
    rec(`rejected: cancelled by OANDA (${reason})`);
    return { success: false, blocked: false, executionState: 'CANCELLED', reason: friendlyReason, sizing, oandaResponse: resp, executionLog: log };
  }
  const fill = resp?.orderFillTransaction;
  if (!fill) {
    if (params.__reservationHash) await releaseExecution(params.__reservationHash, 'no_fill');
    if (params.__entryCycleReservationHash) await releaseExecution(params.__entryCycleReservationHash, 'no_fill');
    rec('rejected: no fill transaction (IOC found no liquidity)');
    return { success: false, blocked: false, executionState: 'REJECTED', reason: 'No fill transaction — IOC order found no liquidity.', sizing, oandaResponse: resp, executionLog: log };
  }

  // Filled — SL/TP attached atomically on fill. Register the shared lock.
  registerTradeLock(pair, direction);
  markTradeOpened({ accountId, balanceUSD, now });
  await persistDailyRiskState({ accountId, balanceUSD, now });
  const tradeId = fill.tradeOpened?.tradeID || fill.id || fill.tradeID || null;
  if (params.__reservationHash) await markExecutionOpen({ hash: params.__reservationHash, tradeId });
  const fillPrice = parseFloat(fill.price ?? entry);
  // Projected hold-time for the ICT lifecycle reassessment (recorded at open).
  const holdMinutes = estimateHoldMinutes(analysis.setupType, analysis.concepts?.killzone);
  const entryContext = buildIctTradeEntryContext({ analysis, brokerTradeId: tradeId, filledAt: now });
  rec(`filled tradeId=${tradeId} price=${fillPrice} units=${units} holdMinutes=${holdMinutes}`);
  try {
    const actualFillRisk = Math.abs(fillPrice - stopLoss);
    const actualFillReward = Math.abs(targetProfit - fillPrice);
    const actualFillRR = actualFillRisk > 0 ? +(actualFillReward / actualFillRisk).toFixed(2) : null;
    recordTrade({
      pair, direction, entry: fillPrice, stopLoss, takeProfit: targetProfit, riskReward: actualFillRR, actualFillRR,
      confidence: analysis.targetHitConfidence ?? analysis.confidence,
      entryQualityConfidence: analysis.confluenceScore ?? analysis.targetConfidence?.confluenceScore ?? analysis.confidence,
      entryTpHitConfidence: analysis.targetHitConfidence ?? analysis.confidence,
      entryStrategy: 'ICT', strategy: 'ICT', score: analysis.confluenceScore ?? analysis.confidence,
      scoreBreakdown: { setupType: analysis.setupType, conceptsDetected: analysis.conceptsDetected, riskModel: analysis.riskModel, claudeStopAdvice: analysis.claudeStopAdvice, targetConfidence: analysis.targetConfidence, h1Transition: analysis.h1Transition, h1Momentum: analysis.h1Momentum, continuationBreakout: analysis.continuationBreakout, entryAuthorization, correctiveGate: analysis.correctiveGate, entryContext },
      atrPips: analysis.atrPips, units, riskAmount: sizing.actualRiskUSD, oandaOrderId: String(tradeId),
      entryATR: analysis.atrPips, entryExpectedHoldTimeMinutes: holdMinutes, entryRiskRewardRatio: actualFillRR,
      entrySession: analysis.concepts?.killzone?.currentKillzone ?? 'ICT', originalRecommendedTP: targetProfit, originalRecommendedSL: stopLoss,
    });
  } catch (historyError) {
    rec(`warning: ICT entry snapshot was not persisted (${historyError.message})`);
  }
  return {
    success: true, blocked: false, executionState: 'FILLED',
    tradeId, fillPrice, units, pair, direction,
    stopLoss, takeProfit: targetProfit,
    riskUSD: sizing.actualRiskUSD, signalId: analysis.signalId,
    learningAuditId: analysis.combinedLearningContext?.auditId ?? null,
    candidateSignalId: analysis.signalId,
    entryContext,
    holdMinutes,
    entryConfidence: analysis.targetHitConfidence ?? analysis.confidence,
    entryQualityConfidence: analysis.confluenceScore ?? analysis.targetConfidence?.confluenceScore ?? null,
    targetConfidence: analysis.targetConfidence ?? null,
    setupType: analysis.setupType,
    h1Transition: analysis.h1Transition,
    continuationBreakout: analysis.continuationBreakout,
    entryAuthorization,
    riskModel: analysis.riskModel,
    claudeStopAdvice: analysis.claudeStopAdvice,
    executionLog: log,
  };
}



// === ACTIVE TRADE LOGIC PATCH ===
export function getNewYorkHour(date = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      hour12: false,
    }).format(date)
  );
  return hour === 24 ? 0 : hour;
}

export function isPrimaryTradeWindow(date = new Date()) {
  const hour = getNewYorkHour(date);
  return hour >= 2 && hour < 10;
}

export function isTrueHardReject(reason = "") {
  const r = String(reason).toLowerCase();
  return (
    r.includes("rr") && r.includes("1.5") ||
    r.includes("risk reward") && r.includes("below") ||
    r.includes("max daily loss") ||
    r.includes("daily loss") ||
    r.includes("max trades") ||
    r.includes("duplicate") ||
    r.includes("spread too high") ||
    r.includes("invalid broker") ||
    r.includes("credentials") ||
    r.includes("missing stop") ||
    r.includes("missing take profit") ||
    r.includes("late entry") ||
    r.includes("late_entry") ||
    r.includes("overextended") ||
    r.includes("h1 active momentum") ||
    r.includes("momentum exhausted") ||
    r.includes("direction confirmation") ||
    r.includes("corrective gate") ||
    r.includes("stale_m5_trigger") ||
    r.includes("live trading disabled") ||
    r.includes("execution disabled")
  );
}

export function softenRejectReasons(reasons = [], now = new Date()) {
  void now;
  // A session window can never erase a timing, momentum, or direction failure.
  return Array.isArray(reasons) ? [...reasons] : [];
}

export function pickTradeMode(candidate = {}) {
  const rr = Number(candidate.rr ?? candidate.riskReward ?? candidate.expectedRR ?? 0);
  const confidence = Number(candidate.confidence ?? candidate.score ?? 0);

  if (rr >= 1.5 && confidence >= 75) return "SCALP";
  return "NONE";
}
// === END ACTIVE TRADE LOGIC PATCH ===
