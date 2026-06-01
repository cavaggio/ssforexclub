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

  const macro = trade.macroAnalysis || {};
  const regime = trade.marketRegime || {};
  const rawPayloadSignal = trade.raw_payload?.signal || trade.rawPayload?.signal || {};
  const sig = Object.keys(rawPayloadSignal).length ? rawPayloadSignal : trade;
  const sigMacro = sig.macroAnalysis || macro;
  const sigRegime = sig.marketRegime || regime;

  const pnl = toNum(firstDefined(trade, ['pnl', 'realized_pl', 'realizedPL', 'realizedPl', 'profit']));

  let winLoss = firstDefined(trade, ['winLoss', 'win_loss', 'result']);
  if (winLoss === 'pending') winLoss = null;
  if (!winLoss && pnl != null) winLoss = pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven';
  winLoss = winLoss ? String(winLoss).toLowerCase() : null;

  const volatility =
    firstDefined(trade, ['volatility', 'volatilityState']) ||
    sigRegime?.volatility?.state ||
    (typeof sigRegime?.volatility === 'string' ? sigRegime.volatility : null);

  return {
    pair:        firstDefined(trade, ['pair', 'instrument', 'symbol']),
    direction:   normDirection(firstDefined(trade, ['direction', 'side'])),
    entryTime:   toIso(firstDefined(trade, ['entryTime', 'entry_time', 'timestamp', 'openedAt', 'created_at'])),
    exitTime:    toIso(firstDefined(trade, ['exitTime', 'exit_time', 'closedAt', 'resolvedAt'])),
    pnl,
    winLoss,
    session:     firstDefined(trade, ['session', 'entrySession']),
    spread:      toNum(firstDefined(trade, ['spread', 'spreadPips', 'entrySpreadPips'])),
    confidence:  toNum(firstDefined(trade, ['confidence'])),
    signalScore: toNum(firstDefined(trade, ['signalScore', 'signal_score', 'score'])),
    trend:       firstDefined(trade, ['trend']) || sig.trend || null,
    volatility:  volatility || null,
    marketRegime: firstDefined(trade, ['marketRegime', 'market_regime']) ||
                  sigRegime?.regime || null,
    macroBias:   firstDefined(trade, ['macroBias', 'macro_bias']) || sigMacro?.bias || null,
    macroRisk:   firstDefined(trade, ['macroRisk', 'macro_risk']) || sigMacro?.risk || null,
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
