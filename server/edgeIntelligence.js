/**
 * server/edgeIntelligence.js
 *
 * Signal Stack V3 — Edge Intelligence Engine (ADDITIVE, analysis-only).
 *
 *   buildTradeEdgeSnapshot(trade)      → normalised edge snapshot for one trade
 *   analyzeHistoricalEdge(trades)      → where the edge lives (and leaks)
 *   generateAttributionReport(trades)  → human-readable strategy attribution
 *
 * These functions read trade records and produce intelligence. They NEVER place,
 * size, close, or gate a trade. They are deliberately tolerant of partial data:
 * a snapshot field that isn't known is simply null, and aggregations ignore
 * groups with too few samples rather than drawing false conclusions.
 *
 * Accepted input shapes (buildTradeEdgeSnapshot is field-name tolerant):
 *   - a scanner signal augmented with a result (pnl/winLoss),
 *   - a forex_trade_history.json record,
 *   - a Supabase trade_logs row (snake_case),
 *   - a plain object already in snapshot shape.
 *
 * Canonical snapshot:
 *   {
 *     pair, direction, entryTime, exitTime, pnl, winLoss, session, spread,
 *     confidence, signalScore, trend, volatility, marketRegime, macroBias,
 *     macroRisk
 *   }
 */

const MIN_SAMPLES = parseInt(process.env.EDGE_MIN_SAMPLES || '3', 10);

// ─── Field access helpers ────────────────────────────────────────────────────

function firstDefined(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return null;
}

function firstDeepDefined(objects, keys) {
  for (const obj of objects) {
    const v = firstDefined(obj, keys);
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeOutcome(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s || s === 'pending' || s === 'open' || s === 'active') return null;
  if (['win', 'won', 'profit', 'tp', 'take_profit', 'take profit'].includes(s)) return 'win';
  if (['loss', 'lost', 'sl', 'stop_loss', 'stop loss'].includes(s)) return 'loss';
  if (['breakeven', 'break_even', 'break even', 'flat'].includes(s)) return 'breakeven';
  if (['closed', 'resolved', 'completed', 'complete', 'filled'].includes(s)) return null;
  return s;
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toIso(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function normDirection(v) {
  const s = String(v || '').toLowerCase();
  if (s === 'long' || s === 'buy' || s === 'bullish') return 'long';
  if (s === 'short' || s === 'sell' || s === 'bearish') return 'short';
  return null;
}

// ─── buildTradeEdgeSnapshot ──────────────────────────────────────────────────

/**
 * Normalise any trade-ish object into the canonical edge snapshot. Pulls nested
 * V3 intelligence (macroAnalysis / marketRegime) when present on a signal.
 * Returns null only when the input isn't an object.
 */
export function buildTradeEdgeSnapshot(trade) {
  if (!trade || typeof trade !== 'object') return null;

  // Supabase trade_logs commonly store the useful execution/close data inside
  // raw_payload/rawPayload/payload instead of top-level columns. Edge Intelligence
  // must normalize both shapes, otherwise the UI shows 0/0 resolved even when
  // trade_logs has plenty of completed close events.
  const rawPayload = parseJsonObject(trade.raw_payload || trade.rawPayload || trade.payload);
  const rawResult = parseJsonObject(trade.result_payload || trade.resultPayload);
  const closeResult = parseJsonObject(
    rawPayload.closeResult ||
    rawPayload.close_result ||
    rawPayload.close ||
    rawPayload.result ||
    rawResult
  );

  const rawPayloadSignal =
    rawPayload.signal ||
    rawPayload.trade?.signal ||
    rawPayload.order?.signal ||
    trade.raw_payload?.signal ||
    trade.rawPayload?.signal ||
    {};

  const sig = Object.keys(rawPayloadSignal || {}).length ? rawPayloadSignal : trade;
  const macro = trade.macroAnalysis || rawPayload.macroAnalysis || sig.macroAnalysis || {};
  const regime = trade.marketRegime || rawPayload.marketRegime || sig.marketRegime || {};
  const sigMacro = sig.macroAnalysis || macro;
  const sigRegime = sig.marketRegime || regime;

  const sourceObjects = [
    trade,
    closeResult,
    rawResult,
    rawPayload,
    rawPayload.trade,
    rawPayload.order,
    rawPayload.execution,
    rawPayload.close,
    sig,
  ].filter(Boolean);

  const pnl = toNum(firstDeepDefined(sourceObjects, [
    'pnl',
    'realized_pnl',
    'realizedPnl',
    'realized_pl',
    'realizedPL',
    'realizedPl',
    'profit',
    'profit_loss',
    'profitLoss',
    'pl',
    'closePnl',
    'close_pnl',
  ]));

  let winLoss = normalizeOutcome(firstDeepDefined(sourceObjects, [
    'winLoss',
    'win_loss',
    'result',
    'outcome',
    'status',
    'state',
  ]));

  if (!winLoss && pnl != null) {
    winLoss = pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven';
  }

  const volatility =
    firstDeepDefined(sourceObjects, ['volatility', 'volatilityState', 'volatility_state']) ||
    sigRegime?.volatility?.state ||
    (typeof sigRegime?.volatility === 'string' ? sigRegime.volatility : null);

  return {
    pair: firstDeepDefined(sourceObjects, ['pair', 'instrument', 'symbol']),
    direction: normDirection(firstDeepDefined(sourceObjects, ['direction', 'side', 'tradeSide'])),
    entryTime: toIso(firstDeepDefined(sourceObjects, [
      'entryTime',
      'entry_time',
      'openTime',
      'open_time',
      'openedAt',
      'opened_at',
      'timestamp',
      'created_at',
      'createdAt',
    ])),
    exitTime: toIso(firstDeepDefined(sourceObjects, [
      'exitTime',
      'exit_time',
      'closeTime',
      'close_time',
      'closedAt',
      'closed_at',
      'resolvedAt',
      'resolved_at',
      'updated_at',
      'updatedAt',
    ])),
    pnl,
    winLoss,
    session: firstDeepDefined(sourceObjects, ['session', 'entrySession', 'entry_session']),
    spread: toNum(firstDeepDefined(sourceObjects, ['spread', 'spreadPips', 'entrySpreadPips', 'entry_spread_pips'])),
    confidence: toNum(firstDeepDefined(sourceObjects, ['confidence'])),
    signalScore: toNum(firstDeepDefined(sourceObjects, ['signalScore', 'signal_score', 'score'])),
    trend: firstDeepDefined(sourceObjects, ['trend']) || sig.trend || null,
    volatility: volatility || null,
    marketRegime:
      firstDeepDefined(sourceObjects, ['marketRegime', 'market_regime']) ||
      sigRegime?.regime ||
      null,
    macroBias:
      firstDeepDefined(sourceObjects, ['macroBias', 'macro_bias']) ||
      sigMacro?.bias ||
      null,
    macroRisk:
      firstDeepDefined(sourceObjects, ['macroRisk', 'macro_risk']) ||
      sigMacro?.risk ||
      null,
  };
}

// ─── Aggregation core ────────────────────────────────────────────────────────

function isWin(snap) {
  if (snap.winLoss) return snap.winLoss === 'win';
  if (snap.pnl != null) return snap.pnl > 0;
  return null; // unknown — excluded from win-rate math
}

function summarizeGroup(key, snaps) {
  let wins = 0, losses = 0, resolved = 0, totalPnl = 0, pnlCount = 0;
  for (const s of snaps) {
    const w = isWin(s);
    if (w === true) { wins++; resolved++; }
    else if (w === false) { losses++; resolved++; }
    if (s.pnl != null) { totalPnl += s.pnl; pnlCount++; }
  }
  return {
    key,
    trades: snaps.length,
    wins,
    losses,
    winRate: resolved > 0 ? +(wins / resolved * 100).toFixed(1) : null,
    avgPnl: pnlCount > 0 ? +(totalPnl / pnlCount).toFixed(2) : null,
    totalPnl: pnlCount > 0 ? +totalPnl.toFixed(2) : null,
  };
}

/**
 * Group snapshots by a field, summarise, and split into ranked best/worst lists.
 * Only groups with >= MIN_SAMPLES resolved-or-pnl trades are considered, so a
 * single lucky/unlucky trade can't dominate.
 */
function rankByField(snaps, field, { min = MIN_SAMPLES } = {}) {
  const groups = new Map();
  for (const s of snaps) {
    const raw = s[field];
    if (raw === null || raw === undefined || raw === '') continue;
    const key = String(raw);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const summaries = [...groups.entries()]
    .map(([key, list]) => summarizeGroup(key, list))
    .filter((g) => g.trades >= min && g.winRate !== null);

  const ranked = sortByPerformance(summaries);
  return { best: ranked.slice(0, 5), worst: ranked.slice(-5).reverse() };
}

function sortByPerformance(summaries) {
  return [...summaries].sort((a, b) => {
    if (b.winRate !== a.winRate) return b.winRate - a.winRate;
    return (b.avgPnl ?? -Infinity) - (a.avgPnl ?? -Infinity);
  });
}

/**
 * Cross-dimension "conditions": each categorical factor value becomes a labelled
 * condition (e.g. "regime:RANGING", "macroRisk:high", "volatility:expanded"),
 * so we can surface which individual conditions are most/least profitable
 * across pairs and sessions.
 */
const CONDITION_FIELDS = [
  ['marketRegime', 'regime'],
  ['macroRisk', 'macroRisk'],
  ['macroBias', 'macroBias'],
  ['volatility', 'volatility'],
  ['trend', 'trend'],
  ['direction', 'direction'],
];

function rankConditions(snaps, { min = MIN_SAMPLES } = {}) {
  const groups = new Map();
  for (const s of snaps) {
    for (const [field, label] of CONDITION_FIELDS) {
      const raw = s[field];
      if (raw === null || raw === undefined || raw === '') continue;
      const key = `${label}:${raw}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
  }
  const summaries = [...groups.entries()]
    .map(([key, list]) => summarizeGroup(key, list))
    .filter((g) => g.trades >= min && g.winRate !== null);
  const ranked = sortByPerformance(summaries);
  return { best: ranked.slice(0, 6), worst: ranked.slice(-6).reverse() };
}

// ─── analyzeHistoricalEdge ───────────────────────────────────────────────────

/**
 * analyzeHistoricalEdge(trades) → {
 *   bestConditions, worstConditions,
 *   bestPairs, worstPairs,
 *   bestSessions, worstSessions,
 *   bestRegimes, worstRegimes
 * }
 *
 * Accepts raw trade records OR pre-built snapshots; normalises either way.
 */
export function analyzeHistoricalEdge(trades) {
  const snaps = (Array.isArray(trades) ? trades : [])
    .map((t) => (t && t.__snapshot ? t : buildTradeEdgeSnapshot(t)))
    .filter(Boolean);

  const conditions = rankConditions(snaps);
  const pairs = rankByField(snaps, 'pair');
  const sessions = rankByField(snaps, 'session');
  const regimes = rankByField(snaps, 'marketRegime');

  return {
    bestConditions: conditions.best,
    worstConditions: conditions.worst,
    bestPairs: pairs.best,
    worstPairs: pairs.worst,
    bestSessions: sessions.best,
    worstSessions: sessions.worst,
    bestRegimes: regimes.best,
    worstRegimes: regimes.worst,
  };
}

// ─── generateAttributionReport ───────────────────────────────────────────────

/**
 * generateAttributionReport(trades) → a structured + narrative attribution of
 * where the strategy's edge comes from. Combines overall stats with the
 * historical-edge breakdown and a set of plain-language highlights the
 * dashboard / AI panel can render directly.
 */
export function generateAttributionReport(trades) {
  const snaps = (Array.isArray(trades) ? trades : [])
    .map((t) => buildTradeEdgeSnapshot(t))
    .filter(Boolean);

  const overall = summarizeGroup('overall', snaps);
  const edge = analyzeHistoricalEdge(snaps.map((s) => ({ ...s, __snapshot: true })));

  const resolved = snaps.filter((s) => isWin(s) !== null);
  const sampleSufficient = resolved.length >= MIN_SAMPLES;

  const highlights = [];
  if (!sampleSufficient) {
    highlights.push(
      `Only ${resolved.length} resolved trade(s) on record — attribution needs at least ${MIN_SAMPLES} to be meaningful. Treat the breakdown below as preliminary.`,
    );
  }
  pushTop(highlights, edge.bestPairs, 'pair', 'Best-performing instrument');
  pushTop(highlights, edge.worstPairs, 'pair', 'Weakest instrument');
  pushTop(highlights, edge.bestSessions, 'session', 'Strongest session');
  pushTop(highlights, edge.bestRegimes, 'regime', 'Strongest market regime');
  pushTop(highlights, edge.bestConditions, 'condition', 'Most profitable condition');
  pushTop(highlights, edge.worstConditions, 'condition', 'Edge leak (avoid)');

  return {
    generatedAt: null, // stamp at call site (Date.now() is intentionally not used here)
    sampleSufficient,
    minSamples: MIN_SAMPLES,
    overall: {
      trades: overall.trades,
      resolved: resolved.length,
      wins: overall.wins,
      losses: overall.losses,
      winRate: overall.winRate,
      avgPnl: overall.avgPnl,
      totalPnl: overall.totalPnl,
    },
    edge,
    highlights,
  };
}

function pushTop(out, list, kind, label) {
  const top = list && list[0];
  if (!top) return;
  const wr = top.winRate != null ? `${top.winRate}% win` : 'n/a win-rate';
  const pnl = top.avgPnl != null ? `, avg ${top.avgPnl >= 0 ? '+' : ''}${top.avgPnl}` : '';
  out.push(`${label}: ${top.key} (${wr}${pnl}, n=${top.trades}).`);
}

export { MIN_SAMPLES };
