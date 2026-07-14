/**
 * web/lib/edgeAnalytics.ts
 *
 * Signal Stack V3 — Edge Intelligence analytics for the dashboard.
 *
 * The source of truth is the same per-user trade activity/event history shown on
 * the dashboard. Open rows provide entry conditions; matching full-close rows
 * provide exit time and outcome. Partial closes contribute realised P/L but do
 * not mark the trade fully resolved by themselves.
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
  dataSource: 'trade_activity';
  sampleSufficient: boolean;
  minSamples: number;
  overall: {
    trades: number;
    resolved: number;
    outcomes: number;
    wins: number;
    losses: number;
    winRate: number | null;
    avgPnl: number | null;
    totalPnl: number | null;
  };
  edge: HistoricalEdge;
  recentTrades: EdgeSnapshot[];
  highlights: string[];
};

const MIN_SAMPLES = Number(process.env.EDGE_MIN_SAMPLES || 3);
const FULL_CLOSE_EVENTS = new Set(['closed', 'manual_close_executed']);
const PNL_EVENTS = new Set(['closed', 'manual_close_executed', 'partial_closed']);

function n(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function s(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function timestamp(row: TradeLogRow): number {
  const parsed = Date.parse(row.created_at);
  return Number.isFinite(parsed) ? parsed : 0;
}

function snapshotFromEntryAndEvents(
  tradeId: string | null,
  entry: TradeLogRow,
  events: TradeLogRow[],
): EdgeSnapshot {
  const ordered = [...events].sort((a, b) => timestamp(a) - timestamp(b));
  const opened = ordered.find((row) => row.event_type === 'opened') ?? entry;
  const fullCloses = ordered.filter((row) => FULL_CLOSE_EVENTS.has(row.event_type));
  const fullClose = fullCloses.at(-1) ?? null;
  const pnlValues = ordered
    .filter((row) => PNL_EVENTS.has(row.event_type))
    .map((row) => n(row.pnl ?? row.realized_pl))
    .filter((value): value is number => value !== null);
  const pnl = pnlValues.length > 0
    ? Number(pnlValues.reduce((total, value) => total + value, 0).toFixed(2))
    : n(fullClose?.pnl ?? fullClose?.realized_pl ?? opened?.pnl ?? opened?.realized_pl ?? null);

  let winLoss = s(fullClose?.win_loss ?? opened?.win_loss ?? null);
  if (!winLoss && pnl != null && fullClose) {
    winLoss = pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven';
  }

  return {
    tradeId,
    pair: s(opened?.pair ?? opened?.instrument ?? fullClose?.pair ?? fullClose?.instrument ?? null),
    direction: s(opened?.direction ?? opened?.side ?? null),
    entryTime: s(opened?.entry_time ?? opened?.created_at ?? null),
    exitTime: s(fullClose?.exit_time ?? fullClose?.created_at ?? null),
    pnl,
    winLoss,
    session: s(opened?.session ?? null),
    spread: n(opened?.spread ?? null),
    confidence: n(opened?.confidence ?? null),
    signalScore: n(opened?.signal_score ?? null),
    trend: s(opened?.trend ?? null),
    volatility: s(opened?.volatility ?? null),
    marketRegime: s(opened?.market_regime ?? null),
    macroBias: s(opened?.macro_bias ?? null),
    macroRisk: s(opened?.macro_risk ?? null),
    resolved: Boolean(fullClose) || winLoss != null,
  };
}

/** Reconstruct one trade snapshot from the shared trade-activity event stream. */
export function snapshotsFromTradeLogs(rows: TradeLogRow[]): EdgeSnapshot[] {
  const byTrade = new Map<string, TradeLogRow[]>();
  const orphans: TradeLogRow[] = [];

  for (const row of rows) {
    if (row.trade_id) {
      const list = byTrade.get(row.trade_id) ?? [];
      list.push(row);
      byTrade.set(row.trade_id, list);
    } else {
      orphans.push(row);
    }
  }

  const snapshots: EdgeSnapshot[] = [];

  for (const [tradeId, events] of byTrade) {
    const ordered = [...events].sort((a, b) => timestamp(a) - timestamp(b));
    const entry = ordered.find((row) => row.event_type === 'opened') ?? ordered[0];
    if (!entry) continue;
    snapshots.push(snapshotFromEntryAndEvents(tradeId, entry, ordered));
  }

  // Older rows can lack a recoverable broker trade ID. Keep them visible rather
  // than making Edge Intelligence appear empty; each open/full-close row becomes
  // a standalone historical snapshot.
  for (const row of orphans) {
    if (row.event_type === 'opened') {
      snapshots.push(snapshotFromEntryAndEvents(null, row, [row]));
      continue;
    }
    if (FULL_CLOSE_EVENTS.has(row.event_type)) {
      snapshots.push(snapshotFromEntryAndEvents(null, row, [row]));
    }
  }

  return snapshots.sort((a, b) => {
    const aTime = Date.parse(a.exitTime ?? a.entryTime ?? '') || 0;
    const bTime = Date.parse(b.exitTime ?? b.entryTime ?? '') || 0;
    return bTime - aTime;
  });
}

function isWin(snapshot: EdgeSnapshot): boolean | null {
  if (snapshot.winLoss) {
    if (snapshot.winLoss === 'win') return true;
    if (snapshot.winLoss === 'loss' || snapshot.winLoss === 'breakeven') return false;
  }
  if (snapshot.resolved && snapshot.pnl != null) return snapshot.pnl > 0;
  return null;
}

function summarize(key: string, snapshots: EdgeSnapshot[]): GroupSummary {
  let wins = 0;
  let losses = 0;
  let knownOutcomes = 0;
  let totalPnl = 0;
  let pnlCount = 0;

  for (const snapshot of snapshots) {
    const won = isWin(snapshot);
    if (won === true) {
      wins += 1;
      knownOutcomes += 1;
    } else if (won === false) {
      losses += 1;
      knownOutcomes += 1;
    }
    if (snapshot.pnl != null) {
      totalPnl += snapshot.pnl;
      pnlCount += 1;
    }
  }

  return {
    key,
    trades: snapshots.length,
    wins,
    losses,
    winRate: knownOutcomes > 0 ? Number(((wins / knownOutcomes) * 100).toFixed(1)) : null,
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

function rankByField(snapshots: EdgeSnapshot[], field: keyof EdgeSnapshot, min = MIN_SAMPLES) {
  const groups = new Map<string, EdgeSnapshot[]>();
  for (const snapshot of snapshots) {
    const raw = snapshot[field];
    if (raw === null || raw === undefined || raw === '') continue;
    const key = String(raw);
    const list = groups.get(key) ?? [];
    list.push(snapshot);
    groups.set(key, list);
  }
  const summaries = [...groups.entries()]
    .map(([key, list]) => summarize(key, list))
    .filter((group) => group.trades >= min && group.winRate !== null);
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

function rankConditions(snapshots: EdgeSnapshot[], min = MIN_SAMPLES) {
  const groups = new Map<string, EdgeSnapshot[]>();
  for (const snapshot of snapshots) {
    for (const [field, label] of CONDITION_FIELDS) {
      const raw = snapshot[field];
      if (raw === null || raw === undefined || raw === '') continue;
      const key = `${label}:${raw}`;
      const list = groups.get(key) ?? [];
      list.push(snapshot);
      groups.set(key, list);
    }
  }
  const summaries = [...groups.entries()]
    .map(([key, list]) => summarize(key, list))
    .filter((group) => group.trades >= min && group.winRate !== null);
  const ranked = sortByPerformance(summaries);
  return { best: ranked.slice(0, 6), worst: ranked.slice(-6).reverse() };
}

export function analyzeHistoricalEdge(scoredSnapshots: EdgeSnapshot[]): HistoricalEdge {
  const conditions = rankConditions(scoredSnapshots);
  const pairs = rankByField(scoredSnapshots, 'pair');
  const sessions = rankByField(scoredSnapshots, 'session');
  const regimes = rankByField(scoredSnapshots, 'marketRegime');
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

function pushTop(output: string[], list: GroupSummary[], label: string) {
  const top = list[0];
  if (!top) return;
  const winRate = top.winRate != null ? `${top.winRate}% win` : 'n/a win-rate';
  const pnl = top.avgPnl != null ? `, avg ${top.avgPnl >= 0 ? '+' : ''}${top.avgPnl}` : '';
  output.push(`${label}: ${top.key} (${winRate}${pnl}, n=${top.trades}).`);
}

export function generateAttributionReport(rows: TradeLogRow[], nowIso: string): AttributionReport {
  const snapshots = snapshotsFromTradeLogs(rows);
  const resolved = snapshots.filter((snapshot) => snapshot.resolved);
  const scored = snapshots.filter((snapshot) => isWin(snapshot) !== null);
  const overall = summarize('overall', scored);
  const edge = analyzeHistoricalEdge(scored);
  const sampleSufficient = scored.length >= MIN_SAMPLES;

  const highlights: string[] = [];
  if (!sampleSufficient) {
    highlights.push(
      `${resolved.length} trade(s) are closed and ${scored.length} have a known P/L outcome; at least ${MIN_SAMPLES} scored outcomes are needed to judge the edge.`,
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
    dataSource: 'trade_activity',
    sampleSufficient,
    minSamples: MIN_SAMPLES,
    overall: {
      trades: snapshots.length,
      resolved: resolved.length,
      outcomes: scored.length,
      wins: overall.wins,
      losses: overall.losses,
      winRate: overall.winRate,
      avgPnl: overall.avgPnl,
      totalPnl: overall.totalPnl,
    },
    edge,
    recentTrades: snapshots.slice(0, 12),
    highlights,
  };
}
