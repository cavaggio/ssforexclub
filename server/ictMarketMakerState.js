/** Persistent ICT market-maker cycle storage backed by daily_market_studies. */

import { createClient } from '@supabase/supabase-js';
import { createIctMarketMakerCycle, normalizeIctDirection } from './ictMarketMakerModel.js';

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

export function ictNewYorkDateKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now instanceof Date ? now : new Date(now));
}

function keyOf(accountId, pair, studyDate) {
  return `${String(accountId)}:ict:${String(pair || '').toUpperCase()}:${studyDate}`;
}

function directionFromStudy(study = {}) {
  const analysis = study.engine_analysis || study.engineAnalysis || {};
  const timeframe = analysis.timeframeBias || analysis.concepts?.htf || {};
  const daily = normalizeIctDirection(timeframe.d1 || timeframe.dailyBias || analysis.ictBias);
  const h4 = normalizeIctDirection(timeframe.h4 || timeframe.h4Bias || analysis.ictBias);
  return daily && daily === h4 ? daily : normalizeIctDirection(analysis.ictBias || study.day_direction);
}

function contextFromRow(row) {
  if (!row) return null;
  const featureSnapshot = row.feature_snapshot && typeof row.feature_snapshot === 'object'
    ? row.feature_snapshot
    : {};
  return {
    studyReady: true,
    studyDate: row.study_date,
    studiedAt: row.studied_at,
    featureSnapshot,
    cycle: featureSnapshot.ictMarketMakerCycle || null,
    storage: 'supabase',
  };
}

export async function loadIctMarketMakerContext({ client, pair, now = new Date() } = {}) {
  const accountId = accountIdOf(client);
  const normalizedPair = String(pair || '').toUpperCase();
  const studyDate = ictNewYorkDateKey(now);
  const key = keyOf(accountId, normalizedPair, studyDate);
  if (memory.has(key)) return structuredClone(memory.get(key));

  const supabase = db();
  if (!supabase) {
    return { studyReady: false, studyDate, studiedAt: null, featureSnapshot: {}, cycle: null, storage: 'memory' };
  }
  const { data, error } = await supabase
    .from('daily_market_studies')
    .select('study_date,studied_at,feature_snapshot')
    .eq('account_id', accountId)
    .eq('engine', 'ict')
    .eq('pair', normalizedPair)
    .eq('study_date', studyDate)
    .maybeSingle();
  if (error) throw new Error(`ICT market-maker study read failed for ${normalizedPair}: ${error.message}`);
  const context = contextFromRow(data) || {
    studyReady: false, studyDate, studiedAt: null, featureSnapshot: {}, cycle: null, storage: 'supabase',
  };
  memory.set(key, context);
  return structuredClone(context);
}

async function writeContext({ client, pair, context }) {
  const accountId = accountIdOf(client);
  const normalizedPair = String(pair || '').toUpperCase();
  const key = keyOf(accountId, normalizedPair, context.studyDate);
  memory.set(key, structuredClone(context));
  const supabase = db();
  if (!supabase) return { persisted: false, storage: 'memory' };

  const { data, error } = await supabase
    .from('daily_market_studies')
    .update({ feature_snapshot: context.featureSnapshot })
    .eq('account_id', accountId)
    .eq('engine', 'ict')
    .eq('pair', normalizedPair)
    .eq('study_date', context.studyDate)
    .select('study_date')
    .maybeSingle();
  if (error) throw new Error(`ICT market-maker cycle persistence failed for ${normalizedPair}: ${error.message}`);
  if (!data) throw new Error(`ICT market-maker cycle persistence failed for ${normalizedPair}: current-day study row is missing.`);
  return { persisted: true, storage: 'supabase' };
}

export async function initializeIctMarketMakerStudy({ client, pair, study, now = new Date() } = {}) {
  const studyDate = String(study?.study_date || ictNewYorkDateKey(now));
  const studiedAt = String(study?.studied_at || (now instanceof Date ? now : new Date(now)).toISOString());
  const featureSnapshot = study?.feature_snapshot && typeof study.feature_snapshot === 'object'
    ? { ...study.feature_snapshot }
    : {};
  const cycle = createIctMarketMakerCycle({
    pair,
    direction: directionFromStudy(study),
    studyDate,
    studiedAt,
    powerOf3: study?.engine_analysis?.concepts?.powerOf3,
  });
  featureSnapshot.ictMarketMakerCycle = cycle;
  const context = {
    studyReady: true,
    studyDate,
    studiedAt,
    featureSnapshot,
    cycle,
    storage: db() ? 'supabase' : 'memory',
  };
  const storage = await writeContext({ client, pair, context });
  return { ...context, ...storage };
}

export async function persistIctMarketMakerCycle({ client, pair, context, cycle } = {}) {
  if (context?.studyReady !== true || !context?.studyDate || !cycle) {
    throw new Error(`ICT market-maker cycle persistence requires a current-day study for ${pair || 'unknown pair'}.`);
  }
  const featureSnapshot = {
    ...(context.featureSnapshot || {}),
    ictMarketMakerCycle: cycle,
  };
  const next = { ...context, cycle, featureSnapshot };
  const storage = await writeContext({ client, pair, context: next });
  return { ...next, ...storage };
}

export function __resetIctMarketMakerStateForTests() {
  memory.clear();
  supabaseClient = undefined;
}
