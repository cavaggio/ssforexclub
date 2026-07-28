import { createClient } from '@supabase/supabase-js';
import { getCandles } from './oandaMarketData.js';
import { analyzeICTPair } from './ictEngine.js';
import { configuredIctWatchlist } from './ictWatchlist.js';
import { analyzePprPair, getPprWatchlist } from './pprEngine.js';

const memory = new Map();
let supabaseClient;

function db() {
  if (supabaseClient !== undefined) return supabaseClient;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  supabaseClient = url && key
    ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;
  return supabaseClient;
}

function accountIdOf(client) {
  return String(client?.accountId || client?.accountID || client?.account_id || 'default');
}

function nyDateKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function keyOf(accountId, engine, pair) {
  return `${accountId}:${engine}:${pair}`;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteCandle(candle) {
  if (!candle || typeof candle !== 'object') return null;
  const open = Number(candle.open);
  const high = Number(candle.high);
  const low = Number(candle.low);
  const close = Number(candle.close);
  if (![open, high, low, close].every(Number.isFinite) || high < low) return null;
  return { ...candle, open, high, low, close };
}

function validCandles(candles) {
  return Array.isArray(candles) ? candles.map(finiteCandle).filter(Boolean) : [];
}

function candleTime(candle, fallbackIndex) {
  return candle?.time || candle?.timestamp || candle?.date || String(fallbackIndex);
}

export function findUntestedZones(candles, timeframe, { maxZones = 10, lookback = 40 } = {}) {
  const source = validCandles(candles).slice(-Math.max(3, lookback));
  const zones = [];
  for (let index = 0; index < source.length - 1; index += 1) {
    const candle = source[index];
    const later = source.slice(index + 1);
    const highRetested = later.some((item) => item.low <= candle.high && item.high >= candle.high);
    const lowRetested = later.some((item) => item.low <= candle.low && item.high >= candle.low);
    if (!highRetested) {
      zones.push({ timeframe, type: 'untested_high', price: candle.high, formedAt: candleTime(candle, index) });
    }
    if (!lowRetested) {
      zones.push({ timeframe, type: 'untested_low', price: candle.low, formedAt: candleTime(candle, index) });
    }
  }
  return zones.slice(-maxZones);
}

function dayMetrics(dailyCandles) {
  const source = validCandles(dailyCandles);
  const current = source.at(-1) || null;
  const prior = source.at(-2) || null;
  if (!current) {
    return {
      open: null, high: null, low: null, close: null, direction: 'neutral',
      range: null, bodyRatio: null, closeLocation: null, sweptPriorHigh: false, sweptPriorLow: false,
      priorDayHigh: prior?.high ?? null, priorDayLow: prior?.low ?? null,
    };
  }
  const range = Math.max(0, current.high - current.low);
  const direction = current.close > current.open ? 'bullish' : current.close < current.open ? 'bearish' : 'neutral';
  return {
    open: current.open,
    high: current.high,
    low: current.low,
    close: current.close,
    direction,
    range,
    bodyRatio: range > 0 ? Math.abs(current.close - current.open) / range : 0,
    closeLocation: range > 0 ? (current.close - current.low) / range : 0.5,
    sweptPriorHigh: Boolean(prior && current.high > prior.high && current.close < prior.high),
    sweptPriorLow: Boolean(prior && current.low < prior.low && current.close > prior.low),
    priorDayHigh: prior?.high ?? null,
    priorDayLow: prior?.low ?? null,
  };
}

function summarizeInstitutionalFlow(metrics) {
  if (metrics.sweptPriorLow && metrics.direction === 'bullish') {
    return { type: 'sell_side_liquidity_raid', direction: 'bullish', strength: 'high' };
  }
  if (metrics.sweptPriorHigh && metrics.direction === 'bearish') {
    return { type: 'buy_side_liquidity_raid', direction: 'bearish', strength: 'high' };
  }
  if (metrics.bodyRatio >= 0.55) {
    return { type: 'directional_displacement', direction: metrics.direction, strength: 'medium' };
  }
  return { type: 'balanced_or_accumulation', direction: 'neutral', strength: 'low' };
}

function candidateDirection(candidate = {}) {
  const value = String(candidate.direction || candidate.signal || '').toLowerCase();
  if (value === 'long' || value === 'buy' || value === 'bullish') return 'bullish';
  if (value === 'short' || value === 'sell' || value === 'bearish') return 'bearish';
  return 'neutral';
}

function confidenceAdjustmentFromStudy(candidate, study) {
  const direction = candidateDirection(candidate);
  if (direction === 'neutral' || !study) return { adjustment: 0, reasons: [] };
  const reasons = [];
  let adjustment = 0;
  if (study.day_direction === direction) {
    adjustment += 1;
    reasons.push(`signal aligns with the latest studied ${study.day_direction} daily flow`);
  } else if (study.day_direction && study.day_direction !== 'neutral') {
    adjustment -= 1;
    reasons.push(`signal opposes the latest studied ${study.day_direction} daily flow`);
  }

  const entry = Number(candidate.entry ?? candidate.entryPrice ?? candidate.currentPrice);
  const dailyZones = Array.isArray(study.untested_daily_zones) ? study.untested_daily_zones : [];
  const h4Zones = Array.isArray(study.untested_h4_zones) ? study.untested_h4_zones : [];
  const zones = [...dailyZones, ...h4Zones];
  if (Number.isFinite(entry) && zones.length) {
    const below = zones.filter((zone) => Number(zone.price) < entry).sort((a, b) => Number(b.price) - Number(a.price))[0];
    const above = zones.filter((zone) => Number(zone.price) > entry).sort((a, b) => Number(a.price) - Number(b.price))[0];
    if (direction === 'bullish' && above?.type === 'untested_high') {
      adjustment += 1;
      reasons.push('an untested Daily/4H high remains available as upside liquidity');
    }
    if (direction === 'bearish' && below?.type === 'untested_low') {
      adjustment += 1;
      reasons.push('an untested Daily/4H low remains available as downside liquidity');
    }
  }

  return { adjustment: Math.max(-2, Math.min(2, adjustment)), reasons };
}

async function persistStudy(row) {
  memory.set(keyOf(row.account_id, row.engine, row.pair), row);
  const supabase = db();
  if (!supabase) return { persisted: false, storage: 'memory' };
  const { error } = await supabase
    .from('daily_market_studies')
    .upsert(row, { onConflict: 'account_id,engine,pair,study_date' });
  if (error) throw new Error(`daily market study persistence failed: ${error.message}`);
  return { persisted: true, storage: 'supabase' };
}

export async function loadLatestMarketStudy({ accountId, engine, pair } = {}) {
  const normalizedAccount = String(accountId || 'default');
  const normalizedEngine = String(engine || '').toLowerCase();
  const normalizedPair = String(pair || '').toUpperCase();
  const local = memory.get(keyOf(normalizedAccount, normalizedEngine, normalizedPair));
  if (local) return local;
  const supabase = db();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('daily_market_studies')
    .select('*')
    .eq('account_id', normalizedAccount)
    .eq('engine', normalizedEngine)
    .eq('pair', normalizedPair)
    .order('study_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn(`[DAILY_STUDY] latest-study read failed ${normalizedEngine}/${normalizedPair}: ${error.message}`);
    return null;
  }
  if (data) memory.set(keyOf(normalizedAccount, normalizedEngine, normalizedPair), data);
  return data || null;
}

export async function applyStoredStudyCalibration(candidate, { client, engine } = {}) {
  const pair = String(candidate?.pair || candidate?.instrument || '').toUpperCase();
  if (!pair) return candidate;
  const study = await loadLatestMarketStudy({ accountId: accountIdOf(client), engine, pair });
  if (!study) return candidate;
  const baseConfidence = Number(candidate.confidence ?? candidate.score ?? 0);
  const { adjustment, reasons } = confidenceAdjustmentFromStudy(candidate, study);
  if (!Number.isFinite(baseConfidence) || adjustment === 0) {
    return { ...candidate, dailyStudyContext: { studyDate: study.study_date, adjustment: 0, reasons } };
  }
  return {
    ...candidate,
    confidence: Math.max(0, Math.min(100, baseConfidence + adjustment)),
    dailyStudyContext: {
      studyDate: study.study_date,
      adjustment,
      reasons,
      priorDayHigh: study.prior_day_high,
      priorDayLow: study.prior_day_low,
      institutionalFlow: study.institutional_flow,
      untestedDailyZones: study.untested_daily_zones,
      untestedH4Zones: study.untested_h4_zones,
    },
  };
}

async function fetchStudyCandles(pair, client) {
  const specs = [
    ['monthly', 'M', 8], ['weekly', 'W', 16], ['daily', 'D', 90],
    ['h4', 'H4', 180], ['h1', 'H1', 240], ['m15', 'M15', 160], ['m5', 'M5', 120],
  ];
  const values = await Promise.all(specs.map(([, granularity, count]) =>
    getCandles(pair, granularity, count, { client }).catch((error) => {
      console.warn(`[DAILY_STUDY] candle fetch failed ${pair}/${granularity}: ${error.message}`);
      return [];
    })
  ));
  return Object.fromEntries(specs.map(([name], index) => [name, values[index]]));
}

export function pprStudyAnalysisTime(now = new Date()) {
  const source = now instanceof Date ? now : new Date(now);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(source);
  const read = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  const currentMinutes = (read('hour') % 24) * 60 + read('minute');
  const studyCutoffMinutes = 9 * 60 + 59;
  return new Date(source.getTime() + (studyCutoffMinutes - currentMinutes) * 60_000);
}

export function dailyStudyLearningCandidate(study = {}) {
  const engineAnalysis = object(study.engine_analysis ?? study.engineAnalysis);
  const signal = object(engineAnalysis.signal);
  const analysis = { ...engineAnalysis, ...signal };
  const concepts = object(analysis.concepts);
  const htf = object(analysis.htf);
  const session = object(analysis.session);
  const direction = analysis.direction || analysis.ictBias || study.day_direction || null;
  const entry = finiteNumber(
    analysis.entry ?? analysis.entryPrice ?? analysis.currentPrice ?? analysis.fillPrice ?? study.day_close,
  );
  const stopLoss = finiteNumber(analysis.stopLoss ?? analysis.sl ?? analysis.structuralStop);
  const takeProfit = finiteNumber(
    analysis.takeProfit ?? analysis.target1 ?? analysis.targetProfit ?? analysis.tp ?? analysis.target,
  );
  const expectedRR = finiteNumber(analysis.expectedRR ?? analysis.rr ?? analysis.riskReward);
  const confidence = finiteNumber(analysis.confidence ?? analysis.entryQualityConfidence ?? analysis.score);
  const rejectionReasons = Array.isArray(analysis.rejectionReasons) ? analysis.rejectionReasons : [];
  const missingConfirmations = Array.isArray(analysis.missingConfirmations)
    ? analysis.missingConfirmations
    : Array.isArray(concepts.missingConfluence)
      ? concepts.missingConfluence
      : [];

  return {
    pair: String(study.pair || '').toUpperCase(),
    engine: String(study.engine || '').toLowerCase(),
    status: 'market_study',
    direction,
    entry,
    entryPrice: entry,
    currentPrice: entry,
    stopLoss,
    takeProfit,
    expectedRR,
    rr: expectedRR,
    confidence,
    spreadPips: finiteNumber(analysis.spreadPips ?? object(analysis.pricing).spreadPips),
    atrPips: finiteNumber(analysis.atrPips),
    session: session.name || analysis.currentKillzone || 'daily_study',
    dailyDirection: study.day_direction || null,
    h4Direction: analysis.h4Direction || htf.h4Bias || null,
    volatilityState: analysis.volatilityState || null,
    institutionalFlow: study.institutional_flow || null,
    conceptsDetected: Array.isArray(analysis.conceptsDetected) ? analysis.conceptsDetected : [],
    missingConfirmations,
    reason: analysis.reason || rejectionReasons.join('; ') || null,
    analysis: {
      ...analysis,
      direction,
      status: 'market_study',
      dailyDirection: study.day_direction || null,
      h4Direction: analysis.h4Direction || htf.h4Bias || null,
      institutionalFlow: study.institutional_flow || null,
      studyMode: true,
    },
    dailyStudyContext: {
      studyDate: study.study_date || null,
      studiedAt: study.studied_at || null,
      dayDirection: study.day_direction || null,
      dayOpen: finiteNumber(study.day_open),
      dayHigh: finiteNumber(study.day_high),
      dayLow: finiteNumber(study.day_low),
      dayClose: finiteNumber(study.day_close),
      priorDayHigh: finiteNumber(study.prior_day_high),
      priorDayLow: finiteNumber(study.prior_day_low),
      institutionalFlow: study.institutional_flow || null,
      untestedDailyZones: Array.isArray(study.untested_daily_zones) ? study.untested_daily_zones : [],
      untestedH4Zones: Array.isArray(study.untested_h4_zones) ? study.untested_h4_zones : [],
    },
    featureSnapshot: study.feature_snapshot || {},
  };
}

async function studyPair({ client, engine, pair, now }) {
  const candles = await fetchStudyCandles(pair, client);
  const metrics = dayMetrics(candles.daily);
  const institutionalFlow = summarizeInstitutionalFlow(metrics);
  let engineAnalysis;
  if (engine === 'ict') {
    engineAnalysis = analyzeICTPair({ pair, candles, peers: {}, now });
  } else {
    const analysisNow = pprStudyAnalysisTime(now);
    engineAnalysis = await analyzePprPair({ pair, client, now: analysisNow });
    engineAnalysis = {
      ...engineAnalysis,
      studyMode: true,
      studyClock: {
        observedAt: now.toISOString(),
        analysisAt: analysisNow.toISOString(),
        reason: 'PPR daily study evaluates the full engine at the final eligible minute without enabling execution.',
      },
    };
  }
  const row = {
    account_id: accountIdOf(client),
    environment: String(client?.environment || 'unknown'),
    engine,
    pair,
    study_date: nyDateKey(now),
    studied_at: now.toISOString(),
    day_open: metrics.open,
    day_high: metrics.high,
    day_low: metrics.low,
    day_close: metrics.close,
    day_direction: metrics.direction,
    prior_day_high: metrics.priorDayHigh,
    prior_day_low: metrics.priorDayLow,
    institutional_flow: institutionalFlow,
    untested_daily_zones: findUntestedZones(candles.daily, 'D'),
    untested_h4_zones: findUntestedZones(candles.h4, 'H4'),
    engine_analysis: engineAnalysis,
    feature_snapshot: {
      bodyRatio: metrics.bodyRatio,
      closeLocation: metrics.closeLocation,
      sweptPriorHigh: metrics.sweptPriorHigh,
      sweptPriorLow: metrics.sweptPriorLow,
    },
  };
  const storage = await persistStudy(row);
  return { ...row, ...storage };
}

export async function runDailyMarketStudy({ client, engine, pairs = null, now = new Date() } = {}) {
  const normalizedEngine = String(engine || '').toLowerCase();
  if (normalizedEngine !== 'ict' && normalizedEngine !== 'ppr') {
    throw new Error(`Daily market study only supports ICT and PPR (received ${engine || '<empty>'})`);
  }
  const watchlist = normalizedEngine === 'ict' ? configuredIctWatchlist() : getPprWatchlist();
  const requested = Array.isArray(pairs) && pairs.length
    ? pairs.map((pair) => String(pair).trim().toUpperCase()).filter((pair) => watchlist.includes(pair))
    : watchlist;
  const studies = [];
  const errors = [];
  for (const pair of [...new Set(requested)]) {
    try {
      studies.push(await studyPair({ client, engine: normalizedEngine, pair, now }));
    } catch (error) {
      errors.push({ pair, error: error?.message || String(error) });
    }
  }
  const learningResults = studies.map(dailyStudyLearningCandidate);
  console.log(
    `[DAILY_STUDY][${normalizedEngine.toUpperCase()}] account=${accountIdOf(client)} ` +
    `studied=${studies.length} learningCandidates=${learningResults.length} errors=${errors.length}`,
  );
  return {
    engine: normalizedEngine,
    scanMode: 'daily_study',
    studied: studies.length,
    studies,
    results: learningResults,
    errors,
    executed: [],
    executionAllowed: false,
  };
}

export function __resetDailyMarketStudyForTests() {
  memory.clear();
  supabaseClient = undefined;
}
