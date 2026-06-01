/**
 * web/lib/edgeAnalytics.ts
 *
 * Signal Stack V3 — Edge Intelligence analytics for the dashboard.
 *
 * Mirrors server/edgeIntelligence.js, but operates on Supabase `trade_logs`
 * rows. trade_logs is an event log (one row per opened / closed / reassessed
 * event), so this module first correlates the 'opened' row (entry conditions)
 * with its matching close row (realised pnl / win-loss) by trade_id to
 * reconstruct one snapshot per trade, then aggregates.
 *
 * Pure + read-only: it only reads rows that already exist. It never writes,
 * trades, or influences execution.
 */

import 'server-only';
import type { TradeLogRow } from './tradeLogs';

export type EdgeSnapshot = {
  tradeId: string | null;
  pair: string | null;
  direction: string | null;
  entryTime: string | null;
  exitTime: string | null;
  pnl: number | null;
  winLoss: string | null;
  session: string | null;
  spread: number | null;
  confidence: number | null;
  signalScore: number | null;
  trend: string | null;
  volatility: string | null;
  marketRegime: string | null;
  macroBias: string | null;
  macroRisk: string | null;
  resolved: boolean;
};

export type GroupSummary = {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgPnl: number | null;
  totalPnl: number | null;
};

export type HistoricalEdge = {
  bestConditions: GroupSummary[];
  worstConditions: GroupSummary[];
  bestPairs: GroupSummary[];
  worstPairs: GroupSummary[];
  bestSessions: GroupSummary[];
  worstSessions: GroupSummary[];
  bestRegimes: GroupSummary[];
  worstRegimes: GroupSummary[];
};

export type AttributionReport = {
  generatedAt: string;
  sampleSufficient: boolean;
  minSamples: number;
  overall: {
    trades: number;
    resolved: number;
    wins: number;
    losses: number;
    winRate: number | null;
    avgPnl: number | null;
    totalPnl: number | null;
  };
  edge: HistoricalEdge;
  highlights: string[];
};

const MIN_SAMPLES = Number(process.env.EDGE_MIN_SAMPLES || 3);

const CLOSE_EVENTS = new Set(['closed', 'manual_close_executed', 'partial_closed']);

function n(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}
function s(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * Reconstruct one snapshot per trade from the event log. Entry conditions come
 * from the 'opened' row; pnl / win-loss / exit come from the matching close row.
 * Rows that carry their own pnl but no trade_id are treated as standalone.
 */
export function snapshotsFromTradeLogs(rows: TradeLogRow[]): EdgeSnapshot[] {
  const byTrade = new Map<string, TradeLogRow[]>();
  const orphans: TradeLogRow[] = [];

  for (const r of rows) {
    if (r.trade_id) {
      const list = byTrade.get(r.trade_id) ?? [];
      list.push(r);
      byTrade.set(r.trade_id, list);
    } else {
      orphans.push(r);
    }
  }

  const snaps: EdgeSnapshot[] = [];

  for (const [tradeId, list] of byTrade) {
    const opened = list.find((r) => r.event_type === 'opened');
    const closed = list.find((r) => CLOSE_EVENTS.has(r.event_type));
    const entry = opened ?? list[0];
    const pnl = n(closed?.pnl ?? closed?.realized_pl ?? entry?.pnl ?? null);
    let winLoss = s(closed?.win_loss ?? entry?.win_loss ?? null);
    if (!winLoss && pnl != null) winLoss = pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven';

    snaps.push({
      tradeId,
      pair: s(entry?.pair ?? entry?.instrument ?? closed?.pair ?? closed?.instrument ?? null),
      direction: s(entry?.direction ?? entry?.side ?? null),
      entryTime: s(entry?.entry_time ?? opened?.created_at ?? null),
      exitTime: s(closed?.exit_time ?? closed?.created_at ?? null),
      pnl,
      winLoss,
      session: s(entry?.session ?? null),
      spread: n(entry?.spread ?? null),
      confidence: n(entry?.confidence ?? null),
      signalScore: n(entry?.signal_score ?? null),
      trend: s(entry?.trend ?? null),
      volatility: s(entry?.volatility ?? null),
      marketRegime: s(entry?.market_regime ?? null),
      macroBias: s(entry?.macro_bias ?? null),
      macroRisk: s(entry?.macro_risk ?? null),
      resolved: Boolean(closed) || winLoss != null,
    });
  }

  for (const r of orphans) {
    const pnl = n(r.pnl ?? r.realized_pl ?? null);
    if (pnl == null && !r.win_loss) continue;
    const winLoss = s(r.win_loss) ?? (pnl != null ? (pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven') : null);
    snaps.push({
      tradeId: null,
      pair: s(r.pair ?? r.instrument), direction: s(r.direction ?? r.side),
      entryTime: s(r.entry_time ?? r.created_at), exitTime: s(r.exit_time),
      pnl, winLoss, session: s(r.session), spread: n(r.spread),
      confidence: n(r.confidence), signalScore: n(r.signal_score),
      trend: s(r.trend), volatility: s(r.volatility), marketRegime: s(r.market_regime),
      macroBias: s(r.macro_bias), macroRisk: s(r.macro_risk),
      resolved: winLoss != null,
    });
  }

  return snaps;
}

function isWin(snap: EdgeSnapshot): boolean | null {
  if (snap.winLoss) return snap.winLoss === 'win';
  if (snap.pnl != null) return snap.pnl > 0;
  return null;
}

function summarize(key: string, snaps: EdgeSnapshot[]): GroupSummary {
  let wins = 0, losses = 0, resolved = 0, totalPnl = 0, pnlCount = 0;
  for (const snap of snaps) {
    const w = isWin(snap);
    if (w === true) { wins++; resolved++; }
    else if (w === false) { losses++; resolved++; }
    if (snap.pnl != null) { totalPnl += snap.pnl; pnlCount++; }
  }
  return {
    key,
    trades: snaps.length,
    wins,
    losses,
    winRate: resolved > 0 ? Number(((wins / resolved) * 100).toFixed(1)) : null,
    avgPnl: pnlCount > 0 ? Number((totalPnl / pnlCount).toFixed(2)) : null,
    totalPnl: pnlCount > 0 ? Number(totalPnl.toFixed(2)) : null,
  };
}

function sortByPerformance(list: GroupSummary[]): GroupSummary[] {
  return [...list].sort((a, b) => {
    if ((b.winRate ?? -1) !== (a.winRate ?? -1)) return (b.winRate ?? -1) - (a.winRate ?? -1);
    return (b.avgPnl ?? -Infinity) - (a.avgPnl ?? -Infinity);
  });
}

function rankByField(snaps: EdgeSnapshot[], field: keyof EdgeSnapshot, min = MIN_SAMPLES) {
  const groups = new Map<string, EdgeSnapshot[]>();
  for (const snap of snaps) {
    const raw = snap[field];
    if (raw === null || raw === undefined || raw === '') continue;
    const key = String(raw);
    const list = groups.get(key) ?? [];
    list.push(snap);
    groups.set(key, list);
  }
  const summaries = [...groups.entries()]
    .map(([key, list]) => summarize(key, list))
    .filter((g) => g.trades >= min && g.winRate !== null);
  const ranked = sortByPerformance(summaries);
  return { best: ranked.slice(0, 5), worst: ranked.slice(-5).reverse() };
}

const CONDITION_FIELDS: Array<[keyof EdgeSnapshot, string]> = [
  ['marketRegime', 'regime'],
  ['macroRisk', 'macroRisk'],
  ['macroBias', 'macroBias'],
  ['volatility', 'volatility'],
  ['trend', 'trend'],
  ['direction', 'direction'],
];

function rankConditions(snaps: EdgeSnapshot[], min = MIN_SAMPLES) {
  const groups = new Map<string, EdgeSnapshot[]>();
  for (const snap of snaps) {
    for (const [field, label] of CONDITION_FIELDS) {
      const raw = snap[field];
      if (raw === null || raw === undefined || raw === '') continue;
      const key = `${label}:${raw}`;
      const list = groups.get(key) ?? [];
      list.push(snap);
      groups.set(key, list);
    }
  }
  const summaries = [...groups.entries()]
    .map(([key, list]) => summarize(key, list))
    .filter((g) => g.trades >= min && g.winRate !== null);
  const ranked = sortByPerformance(summaries);
  return { best: ranked.slice(0, 6), worst: ranked.slice(-6).reverse() };
}

export function analyzeHistoricalEdge(snaps: EdgeSnapshot[]): HistoricalEdge {
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

function pushTop(out: string[], list: GroupSummary[], label: string) {
  const top = list[0];
  if (!top) return;
  const wr = top.winRate != null ? `${top.winRate}% win` : 'n/a win-rate';
  const pnl = top.avgPnl != null ? `, avg ${top.avgPnl >= 0 ? '+' : ''}${top.avgPnl}` : '';
  out.push(`${label}: ${top.key} (${wr}${pnl}, n=${top.trades}).`);
}

export function generateAttributionReport(rows: TradeLogRow[], nowIso: string): AttributionReport {
  const snaps = snapshotsFromTradeLogs(rows);
  const overall = summarize('overall', snaps);
  const edge = analyzeHistoricalEdge(snaps);
  const resolved = snaps.filter((snap) => isWin(snap) !== null);
  const sampleSufficient = resolved.length >= MIN_SAMPLES;

  const highlights: string[] = [];
  if (!sampleSufficient) {
    highlights.push(
      `Only ${resolved.length} resolved trade(s) on record — attribution needs at least ${MIN_SAMPLES} to be meaningful. Treat the breakdown below as preliminary.`,
    );
  }
  pushTop(highlights, edge.bestPairs, 'Best-performing instrument');
  pushTop(highlights, edge.worstPairs, 'Weakest instrument');
  pushTop(highlights, edge.bestSessions, 'Strongest session');
  pushTop(highlights, edge.bestRegimes, 'Strongest market regime');
  pushTop(highlights, edge.bestConditions, 'Most profitable condition');
  pushTop(highlights, edge.worstConditions, 'Edge leak (avoid)');

  return {
    generatedAt: nowIso,
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
